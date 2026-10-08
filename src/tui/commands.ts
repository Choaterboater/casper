import { type SlashCommand, visibleWidth } from "@earendil-works/pi-tui";

/** Discoverability only: command dispatch and authorization remain in CasperApp. */
export const COMMANDS: SlashCommand[] = [
  { name: "model", description: "Change model (remembered globally; --session for temporary)" },
  { name: "effort", description: "Reasoning effort, including auto; Shift+Tab cycles and remembers it" },
  { name: "status", description: "Inspect project, model, auth and integrations" },
  { name: "help", description: "Find a command; /help all shows the full reference" },
  { name: "context", description: "Inspect context estimates and capability counts" },
  { name: "usage", description: "Inspect session tokens and available cost estimates" },
  { name: "compact", description: "Summarize context (sends a model request)" },
  { name: "clear", description: "Start a fresh conversation; keep files and saved conversations" },
  { name: "resume", description: "Go back to a saved conversation (a numbered list)" },
  { name: "diff", description: "The last task's changes: /diff 12, /diff list" },
  { name: "undo", description: "Put the last task's files back (no model)" },
  { name: "redo", description: "Put an undone task's files back again" },
  { name: "new", description: "Start a new project in ~/Projects (no model)" },
  { name: "plan", description: "Plan first: the model writes a plan and cases to test, then you build" },
  { name: "suggestions", description: "Suggested next steps: list, or turn on or off" },
  { name: "pane", description: "Steps in a split beside Casper (tmux, iTerm2): /pane on or /pane off, saved" },
  { name: "details", description: "How much work shows: quiet, normal or detailed, remembered (Ctrl+T: the last step in full)" },
  { name: "settings", description: "Turn web lookups, spend notes, built-in skills and more on or off by number" },
  { name: "output", description: "Full command and output of a recent tool call (/output [n|all])" },
  { name: "verify", description: "Run repository verification checks" },
  { name: "security-review", description: "Run the pinned security tools here, then offer an AI review (asks first)" },
  { name: "receipt", description: "A saved receipt: /receipt 12, /receipt list" },
  { name: "project", description: "Inspect project stack, configuration and checks" },
  { name: "skills", description: "Inspect skill metadata, trust and warnings" },
  { name: "pack", description: "Skill packs: add one from a folder or GitHub (asks first), list, remove" },
  { name: "mcp", description: "MCP status; connect, disconnect, writes on/off, forget, docs servers" },
  { name: "lsp", description: "Inspect language-server status; connect or disconnect" },
  { name: "browser", description: "Inspect a disposable browser; capture a screenshot" },
  { name: "services", description: "Declared services: status, logs, start, restart, stop" },
  { name: "preview", description: "Open your web app on a phone on the same Wi-Fi; a public link only after a yes" },
  { name: "tasks", description: "What runs in the background (dev servers, helpers, checks); stop one" },
  { name: "debug", description: "Inspect local targets; approve launch and debug code" },
  { name: "doctor", description: "Check Casper's own setup and fix what it can (no model, asks first)" },
  { name: "permissions", description: "What Casper may do here, and how to be asked less" },
  { name: "sandbox", description: "What the shell sandbox holds here; forget a remembered host" },
  { name: "allowed", description: "The shell commands you said yes to for this project; forget one" },
  { name: "lab", description: "Your lab devices; /lab import <file> marks more; /lab ssh off makes ssh to them ask" },
  { name: "tree", description: "Inspect named conversations and workspaces" },
  { name: "branch", description: "Create a named workspace conversation (requires approval)" },
  { name: "switch", description: "Switch named workspace conversation (requires approval)" },
  { name: "memory", description: "Manage explicit project facts and inspect task outcomes" },
  { name: "references", description: "Search local reference projects; add a vendor spec repo" },
  { name: "secrets", description: "Show what Casper hides from the AI" },
  { name: "visualize", description: "Inspect providers or render repository dependencies" },
  { name: "delegate", description: "Ask a bounded read-only subagent (uses a model)" },
  { name: "crew", description: "A builder does a job in its own copy of the project; you apply it (uses a model)" },
  { name: "login", description: "Set up provider credentials in a private login flow" },
  { name: "exit", description: "Leave Casper" },
];

/** Commands that only show something (or set the model, effort or display level) and so run while a task works. */
export const RUNS_DURING_WORK: ReadonlySet<string> = new Set([
  "help", "status", "usage", "context", "permissions", "effort", "diff", "tasks", "details", "receipt", "output",
  "mcp", "tree", "project", "sandbox", "allowed", "secrets", "skills", "lsp", "pane", "model",
]);

/** This exact line runs now during a task; every other line waits for the task to end. */
export function runsDuringWork(line: string): boolean {
  return /^\/(?:help(?: \S.*)?|status|usage|context|permissions|tree|project|sandbox|allowed|secrets|skills|lsp|mcp)$/.test(line)
    || /^\/(?:diff|receipt)(?:\s+(?:\d+|list))?$/.test(line)
    || /^\/output(?:\s+(?:\d+|all))?$/.test(line)
    || /^\/details(?:\s+(?:quiet|normal|detailed))?(?:\s+--session)?$/.test(line)
    || /^\/tasks(?:\s+stop\s+(?:\d+|all))?$/.test(line)
    || /^\/pane(?:\s+(?:on|off))?$/.test(line)
    || /^\/effort(?:\s+[^\s-]\S*(?:\s+--session)?)?$/.test(line)
    // The picker or one model; role and big-model changes wait (they save settings).
    || /^\/model(?:\s+--session)?(?:\s+(?!(?:roles?|big)(?:\s|$))[^\s-]\S*)?$/.test(line) || line === "/model roles";
}

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
