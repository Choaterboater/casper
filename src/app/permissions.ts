import os from "node:os";
import path from "node:path";
import type { ShellSandbox } from "../sandbox/manager";
import { closestWord } from "../tui/closest";
import { PERMISSIONS_ALL_ALIASES } from "../tui/commands";
import { displayPath, terminalText } from "../tui/format";

/**
 * /permissions: a short screen that leads with whether Casper is asking, then one line per kind (state · how to
 * change it) and what stays protected; `/permissions details` is the full screen: where each permission came from
 * (this session, remembered for this project, your config) and, for each kind, every way to be asked less or more.
 * It also holds the person's own switches: `/permissions all` (stop asking until you quit), `/permissions ask`,
 * `/permissions write <folder>` and `/permissions forget <folder>`. Only the person's typed command reaches them.
 */

export const PERMISSIONS_USAGE = "Usage: /permissions [details] | /permissions all|ask | /permissions write|forget <folder>";

/** `all` has other spellings (PERMISSIONS_ALL_ALIASES), safe because it changes nothing until you pick 2 in its own
 * box. `ask` has none: it is already one short word, and a typo of it gets a suggestion. These words mean `all` but
 * are not spelled like it: they are suggested, never run. */
const MEANS_ALL = new Set(["allow", "yolo", "everything", "stop"]);
/** Words that, followed by a folder, mean `write` rather than `all` (`allow-all <folder>` reaches here as `all <folder>`). */
const ALLOW_WORDS = new Set<string>(["all", "allow", ...PERMISSIONS_ALL_ALIASES]);
const PERMISSIONS_WORDS = ["all", "ask", "details", "write", "forget"];

export interface PermissionsView {
  /** The app that runs casper acp set Read only (decision 82). */
  readOnly?: boolean;
  /** Commands while planning (plan_commands, decision 95): unset is on. */
  planCommands?: boolean;
  /** Commands that read private places (private_commands, decision 95): unset is on. */
  privateCommands?: boolean;
  /** The shell's own paragraph and the last line of /permissions as it was (permissionsText). */
  shell: string;
  /** Whether you trust the open folder, in a sentence (folderTrustText): its checks and project commands depend on it. */
  folder?: string;
  /** Why the shell is not sandboxed here ("Windows"), and whether it then asks before each command. */
  sandboxReason?: string;
  shellAsks?: boolean;
  /** Routine commands (on unless false): with no sandbox, routine work runs without the box too. */
  routine?: boolean;
  scripts: string;
  asking: boolean;
  sandboxOn: boolean;
  /** Whether an edit or write outside the project asks (false with --no-sandbox or sandbox: off). */
  outsideWritesAsk: boolean;
  /** Commands you said yes to: for this session only, and remembered for this project (/allowed). */
  commandsSession: number;
  commandsSaved: number;
  listedHosts: number;
  rememberedHosts: readonly string[];
  reachHosts: readonly string[];
  labDevices: number;
  labAsks: boolean | undefined;
  /** `sandbox.checks` (your config) and whether you said "always for this project" to running its checks outside the sandbox. */
  checks: "ask" | "outside" | "inside";
  checksRemembered: boolean;
  /** `sandbox.commands` (your config): what a shell command the sandbox blocked does (decision 94). Unset: ask. */
  commands?: "ask" | "outside" | "inside";
  /** Kinds of git and gh command that use your GitHub login outside the sandbox without asking (`git push`, `gh pr create (this session)`). */
  githubLogin?: readonly string[];
  writesForGood: readonly string[];
  writesSession: readonly string[];
  mcpWritesOn: readonly string[];
  mcpAllowAll: readonly string[];
  /** Your own servers that started with writes on (My MCP servers): their changes run without the change box. */
  mcpOwnWrites?: readonly string[];
  web: boolean;
  github: boolean;
  sshLogin: boolean;
  downloads: boolean;
  show: (folder: string) => string;
}

const list = (items: readonly string[], none = "none") => (items.length ? items.join(", ") : none);

/** What a command the sandbox blocks does now (decision 94, sandbox.commands). */
function blockedWords(view: Pick<PermissionsView, "commands" | "asking">): string {
  const mode = view.commands ?? "ask";
  if (mode === "inside") return "a command the sandbox blocks stays blocked: sandbox: commands: inside";
  if (mode === "outside") return "a command the sandbox blocks runs once outside it without a box: sandbox: commands: outside";
  return `a command the sandbox blocks can run once outside it: ${view.asking ? "it asks" : "Don't ask runs it without a box"}`;
}

/** What stays protected whatever you pick: private places can't be read; protected ones can be read, not changed. */
function protectedWords(view: Pick<PermissionsView, "commands" | "asking" | "sandboxOn" | "privateCommands">, opens: string, detail = false): string {
  // Decision 95: with private_commands on they ask first, naming the place; off, they are refused as before.
  const asked = view.privateCommands !== false
    ? `the AI's file tools${view.sandboxOn ? "" : " and a command naming one"} ask first, naming the place${detail ? ", also with /permissions all; where nobody can answer they are refused" : ""}${view.sandboxOn ? ", and the sandbox hides them from commands" : ""} (Commands that read private places in /settings)`
    : "the AI's file tools and a command naming one are refused, sandbox or not (Commands that read private places is off in /settings)";
  return `~/.ssh, cloud logins and Casper's own logins and records are private: ${asked}, unless ${opens} opens one; `
    + "~/.casper, shell start-up files and git's own files can be read, but the AI's edit and write can't change them"
    + (view.sandboxOn ? `, and the sandbox blocks a command that does (${blockedWords(view)})` : ", and a command that does is like any other command (Run this command?)");
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** "A", "A and B", "A, B and C". */
const and = (items: readonly string[]) => items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items[0] ?? "";

/** What Read only means, first on /permissions while the app has it set: what it refuses and the boxes it still asks
 * (decisions 94 and 95), following plan_commands, private_commands and sandbox.commands as the app's own words do
 * (src/acp/modes.ts). */
export function readOnlyLine(view: Pick<PermissionsView, "planCommands" | "privateCommands" | "sandboxOn" | "commands">): string {
  const privatePlace = view.privateCommands !== false ? ["a private place"] : [];
  const outsideLook = view.sandboxOn ? [] : ["a look command reading outside the project"];
  // Decision 94: a look command the sandbox blocked asks to run once outside it, on sandbox.commands: ask.
  const blocked = view.sandboxOn && (view.commands ?? "ask") === "ask" ? ["a look command the sandbox blocked (to run it once outside)"] : [];
  const end = "Pick another access in the app to change it.";
  // With plan_commands off only look commands run, and ssh, scp, git push or gh are not look commands: they are refused
  // before another machine or the GitHub login could ask.
  if (view.planCommands === false) {
    const asks = [...privatePlace, ...outsideLook, ...blocked];
    const still = asks.length ? `; ${and(asks)} still ${asks.length > 1 ? "ask" : "asks"}` : "";
    return `Read only (set by the app): Casper looks and answers. Edits, writes, changing commands, checks and MCP changes are not run${still}. ${end}`;
  }
  const asks = [...privatePlace, "another machine", ...(view.sandboxOn ? ["the GitHub login"] : outsideLook), ...blocked];
  // A new host or write of a command you said yes to asks only where the sandbox holds them (its proxy and write hold).
  const held = view.sandboxOn ? ", and a new host or write of a command you said yes to" : "";
  return `Read only (set by the app): Casper looks and answers. Edits, writes, checks and MCP changes are not run. A command that may change files asks first, and so do ${and(asks)}${held}. ${end}`;
}

/** Plain /permissions: the state first, then one line per kind (state · how to change it), what stays protected and
 * where the rest is. The box that stops asking follows it in a terminal. */
export function permissionsSummary(view: PermissionsView): string {
  const asks = view.asking ? "asks" : "Yes until you quit";
  const shell = view.sandboxOn
    ? `in the sandbox (the project, temp and caches; other folders and hosts: ${asks})`
    : `not sandboxed here (${view.sandboxReason ?? "no sandbox"}), ${!view.shellAsks ? "doesn't ask" : view.asking ? `asks before each command but plain reads${view.routine === false ? " (Routine commands off)" : " and routine work"}` : "Yes until you quit"}`;
  const lab = view.labDevices ? `; ${plural(view.labDevices, "lab device")}: ${view.labAsks === false ? "no asking" : "asks"} (/lab ssh on|off)` : "";
  const before = view.sandboxOn
    ? `a new host, ${view.outsideWritesAsk ? "a write outside the project or " : ""}another machine`
    : [view.shellAsks ? "shell commands" : "", view.outsideWritesAsk ? "writes outside the project" : "", "other machines"].filter(Boolean).join(", ").replace(/, ([^,]*)$/, " and $1");
  const writes = view.outsideWritesAsk ? asks : "doesn't ask (no sandbox)";
  return [
    ...(view.readOnly ? [readOnlyLine(view)] : []),
    view.asking
      ? `Asking is on: Casper asks before ${before}.`
      : "Asking is OFF until you quit: shell commands, hosts, writes outside the project and other machines are answered Yes. /permissions ask turns it back on.",
    ...(view.folder ? [`  Folder: ${view.folder}`] : []),
    `  Shell: ${shell} · said yes to ${view.commandsSession} this session, ${view.commandsSaved} for this project · /allowed`,
    ...(view.sandboxOn ? [`  Hosts commands reach: ${view.listedHosts} listed, remembered: ${list(view.rememberedHosts)}; others: ${asks} · 4 at the box remembers one`] : []),
    `  Other machines (ssh, scp): ${asks} · remembered: ${list(view.reachHosts)}${lab} · 4 at the box remembers one`,
    `  Writes outside the project: ${writes} · allowed: ${list([...view.writesForGood, ...view.writesSession].map(view.show))} · /permissions write <folder>`,
    `  Network devices (MCP): ${view.mcpWritesOn.length ? `writes on: ${list(view.mcpWritesOn)}` : "writes off"} · ${view.mcpAllowAll.length ? `Yes to everything: ${list(view.mcpAllowAll)}; other changes ask` : "each change asks"}${view.mcpOwnWrites?.length ? ` · your own, changes don't ask: ${list(view.mcpOwnWrites)}` : ""} · /mcp writes <server>`,
    ...(view.sandboxOn ? [`  GitHub login: asks · allowed: ${list(view.githubLogin ?? [])} · /allowed forget <n>`] : []),
    `Protected: ${protectedWords(view, "sandbox.allowRead")}; secrets stay hidden; device writes and the spend pause keep their own boxes; the AI can't answer a box for you.`,
    "/permissions details shows everything, with every way to change it.",
  ].join("\n");
}

/** `/permissions details`: every fact, where it came from and every way to change it. */
export function permissionsScreen(view: PermissionsView): string {
  const lines = [
    `What Casper may do here, and how to change it. Asking is ${view.asking ? "on" : "OFF until you quit (/permissions ask turns it back on)"}.`,
    ...(view.readOnly ? [readOnlyLine(view)] : []),
    "",
    ...(view.folder ? [view.folder, ""] : []),
    view.shell,
    `  You said yes to: ${view.commandsSession} command${view.commandsSession === 1 ? "" : "s"} for this session, ${view.commandsSaved} for this project (/allowed lists them, /allowed forget <n> takes one back).`,
    "  To stop being asked about one command: answer 3 (this session) or 4 (this project) at its box.",
    "",
    `Other machines (ssh, scp): Casper asks. Remembered for this project: ${list(view.reachHosts)}. Your ${view.labDevices} lab device${view.labDevices === 1 ? "" : "s"}: ${view.labDevices ? (view.labAsks === false ? "ssh to them doesn't ask" : "ssh to them asks first") : "none"} (/lab ssh on|off).`,
    "  To stop being asked: answer 4 at the box, or --allow-reach <host> for one run. A password ssh asks for goes in Casper's own hidden box"
      + `${view.sshLogin ? "" : " (off now)"}; ssh_login: off in ~/.casper/config.yaml turns that box off.`,
    view.sandboxOn
      ? `GitHub login: the sandbox hides it; a plain git push/pull/fetch/clone/ls-remote or gh pr/issue/run/repo/api/auth status asks 'Run outside the sandbox with your GitHub login?' (not answered by /permissions all; a merge, close, reopen, ready, review, checkout, rerun or cancel asks every time; a blocked command you let run outside the sandbox uses your login as typed). Allowed: ${list(view.githubLogin ?? [])} (/allowed forget <n>).`
      : "GitHub login: not sandboxed here, so git and gh use it as they always do.",
    "",
    view.sandboxOn
      ? `Hosts commands reach: ${view.listedHosts} listed, remembered for this project: ${list(view.rememberedHosts)}. Others ask.`
      : "Hosts commands reach: not held here, so no host questions.",
    ...(view.sandboxOn ? ["  To stop being asked: answer 4 at the box, sandbox: allowedDomains in ~/.casper/config.yaml, or --allow-host <host> for one run (/sandbox forget <host> takes one back)."] : []),
    "",
    view.outsideWritesAsk
      ? "Writes outside the project: Casper asks (1 No · 2 Yes, this once · 3 Yes, for this session; the Next row offers to keep it for this project). The project, temp and package caches never ask."
      : "Writes outside the project: with the sandbox off they don't ask.",
    `  Allowed for good: ${list(view.writesForGood.map(view.show))}. This session only: ${list(view.writesSession.map(view.show))}.`,
    "  To stop being asked: answer 4 at the box, /permissions write <folder> ahead of time, sandbox: allowWrite in config, or --allow-write <folder> for one run. /permissions forget <folder> takes one back.",
    "",
    `Your project's checks (tests, typecheck, lint) run ${view.sandboxOn ? "in the sandbox" : "without a sandbox here"}. Outside the sandbox: ${view.checks === "outside" ? "always (sandbox: checks: outside in ~/.casper/config.yaml)" : view.checks === "inside" ? "never, and never asked (sandbox: checks: inside in ~/.casper/config.yaml)" : view.checksRemembered ? "yes, remembered for this project" : "only if you say so when a check is blocked"}.`,
    "  A check the sandbox blocks asks 'Run this project's checks outside the sandbox?' (not answered by /permissions all). To undo \"always\": /allowed forget <n>.",
    ...(view.sandboxOn ? [`An AI shell command: ${blockedWords(view)}, as Claude Code and DeepSeek Harness do. Blocked commands in /settings (sandbox: commands: ask | outside | inside) changes it.`] : []),
    "",
    `Network devices (MCP): a network product's server starts with writes off and each change asks; your own other servers start with writes on (My MCP servers in /settings), and firmware, delete and admin changes still ask. Writes on now: ${list(view.mcpWritesOn)}. Your own with writes on: ${list(view.mcpOwnWrites ?? [])}. Yes to everything on a product: ${list(view.mcpAllowAll)}.`,
    "  To allow changes: answer 2, 3 or 4 in the change box, or /mcp writes <server> and /mcp allow <server> ahead of time. Ctrl+X turns writes off everywhere.",
    "",
    `Switches (/settings): web lookups ${view.web ? "on" : "off"}, GitHub tool ${view.github ? "on" : "off"}. Fetching ripgrep ${view.downloads ? "on" : "off"} (tools: downloads: off in config).`,
    "",
    "To turn everything on: there is no single switch, on purpose. The closest is /permissions all (or type 'stop asking'), or 4 Yes to everything this session in the Run this command? box: until you quit, shell commands, hosts, writes outside the project and other machines are answered Yes for this session (--no-sandbox for one run, or sandbox: off in ~/.casper/config.yaml, takes the shell sandbox away too).",
    `Protected: ${protectedWords(view, "sandbox: allowRead in ~/.casper/config.yaml (Readable private places in /settings)", true)}; secrets are hidden from the AI; device writes still need the product's own login to allow them and their own box; the spend pause stays; the AI can't answer a box for you.`,
    view.scripts,
  ];
  return lines.join("\n");
}

/** What the person typed after /permissions. */
export type PermissionsCommand = { kind: "show" | "details" | "all" | "ask" } | { kind: "write" | "forget"; folder: string };

/** The typed words. An unknown word is never guessed into a switch: the error names the closest one to type. */
export function parsePermissions(prompt: string): PermissionsCommand {
  const rest = prompt.replace(/^\/permissions/, "").trim();
  if (!rest) return { kind: "show" };
  const word = rest.toLowerCase();
  if (word === "all" || (PERMISSIONS_ALL_ALIASES as readonly string[]).includes(word)) return { kind: "all" };
  if (word === "ask") return { kind: "ask" };
  if (word === "details") return { kind: "details" };
  const folder = /^(write|forget)\s+(.+)$/i.exec(rest);
  if (folder) return { kind: folder[1]!.toLowerCase() as "write" | "forget", folder: folder[2]!.trim().replace(/^["']|["']$/g, "") };
  const first = word.split(/\s+/)[0]!;
  // "/permissions allow <folder>" means a folder, not everything: suggest write with what followed.
  const more = rest.slice(rest.search(/\s/) + 1).trim();
  if (/\s/.test(rest) && ALLOW_WORDS.has(first)) throw new Error(`${PERMISSIONS_USAGE}. Did you mean /permissions write ${more}?`);
  const near = MEANS_ALL.has(first) ? "all" : closestWord(first, PERMISSIONS_WORDS);
  throw new Error(near ? `${PERMISSIONS_USAGE}. Did you mean /permissions ${near}${near === "all" ? " (it asks first)" : ""}?` : PERMISSIONS_USAGE);
}

/** A folder as typed: ~ for home, otherwise from the project. */
export function folderFromTyped(typed: string, root: string, home: string = os.homedir()): string {
  return typed === "~" || typed.startsWith("~/") || typed.startsWith("~\\") ? path.join(home, typed.slice(2)) : path.resolve(root, typed);
}

/** /permissions write <folder>: allow a folder for good ahead of time, in plain words. */
export async function allowFolder(sandbox: ShellSandbox, typed: string, root: string, home: string): Promise<string> {
  const result = await sandbox.rememberWrite(folderFromTyped(typed, root, home));
  const shown = terminalText(typed);
  return "refused" in result
    ? `Not allowed: ${shown} ${result.refused}.\n`
    : `Allowed: the AI's edits and shell commands may write ${terminalText(displayPath(result.folder, { root, home }))} and below, for this project. It is kept in ~/.casper, never in the repo; /permissions forget ${shown} takes it back.\n`;
}

export async function forgetFolder(sandbox: ShellSandbox, typed: string, root: string, home: string): Promise<string> {
  const found = await sandbox.forgetWrite(folderFromTyped(typed, root, home));
  return found ? `Forgot ${terminalText(typed)}: Casper asks before writes there again.\n` : `${terminalText(typed)} was not allowed. /permissions shows what is.\n`;
}
