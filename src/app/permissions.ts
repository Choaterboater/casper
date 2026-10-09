import os from "node:os";
import path from "node:path";
import type { ShellSandbox } from "../sandbox/manager";
import { displayPath, terminalText } from "../tui/format";

/**
 * /permissions: one screen that says what Casper may do in this project, where each permission came from (this
 * session, remembered for this project, your config) and, for each kind, the exact way to be asked less or more.
 * It also holds the person's own switches: `/permissions all` (stop asking until you quit), `/permissions ask`,
 * `/permissions write <folder>` and `/permissions forget <folder>`. Only the person's typed command reaches them.
 */

export const PERMISSIONS_USAGE = "Usage: /permissions | /permissions all|ask | /permissions write|forget <folder>";

export interface PermissionsView {
  /** The shell's own paragraph and the last line of /permissions as it was (permissionsText). */
  shell: string;
  scripts: string;
  asking: boolean;
  sandboxOn: boolean;
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
  /** Kinds of git and gh command that use your GitHub login outside the sandbox without asking (`git push`, `gh pr create (this session)`). */
  githubLogin?: readonly string[];
  writesForGood: readonly string[];
  writesSession: readonly string[];
  mcpWritesOn: readonly string[];
  mcpAllowAll: readonly string[];
  web: boolean;
  github: boolean;
  sshLogin: boolean;
  downloads: boolean;
  show: (folder: string) => string;
}

const list = (items: readonly string[], none = "none") => (items.length ? items.join(", ") : none);

export function permissionsScreen(view: PermissionsView): string {
  const lines = [
    `What Casper may do here, and how to change it. Asking is ${view.asking ? "on" : "OFF until you quit (/permissions ask turns it back on)"}.`,
    "",
    view.shell,
    `  You said yes to: ${view.commandsSession} command${view.commandsSession === 1 ? "" : "s"} for this session, ${view.commandsSaved} for this project (/allowed lists them, /allowed forget <n> takes one back).`,
    "  To stop being asked about one command: answer 3 (this session) or 4 (this project) at its box.",
    "",
    `Other machines (ssh, scp): Casper asks. Remembered for this project: ${list(view.reachHosts)}. Your ${view.labDevices} lab device${view.labDevices === 1 ? "" : "s"}: ${view.labDevices ? (view.labAsks === false ? "ssh to them doesn't ask" : "ssh to them asks first") : "none"} (/lab ssh on|off).`,
    "  To stop being asked: answer 4 at the box, or --allow-reach <host> for one run. A password ssh asks for goes in Casper's own hidden box"
      + `${view.sshLogin ? "" : " (off now)"}; ssh_login: off in ~/.casper/config.yaml turns that box off.`,
    view.sandboxOn
      ? `GitHub login: the sandbox hides it; a plain git push/pull/fetch/clone/ls-remote or gh pr/issue/run/repo/api/auth status asks 'Run outside the sandbox with your GitHub login?' (not answered by /permissions all; a merge, close, reopen, ready, review, checkout, rerun or cancel asks every time). Allowed: ${list(view.githubLogin ?? [])} (/allowed forget <n>).`
      : "GitHub login: not sandboxed here, so git and gh use it as they always do.",
    "",
    view.sandboxOn
      ? `Hosts commands reach: ${view.listedHosts} listed, remembered for this project: ${list(view.rememberedHosts)}. Others ask.`
      : "Hosts commands reach: not held here, so no host questions.",
    ...(view.sandboxOn ? ["  To stop being asked: answer 4 at the box, sandbox: allowedDomains in ~/.casper/config.yaml, or --allow-host <host> for one run (/sandbox forget <host> takes one back)."] : []),
    "",
    `Writes outside the project: Casper asks (1 No · 2 Yes, this once · 3 Yes, for this session · 4 Yes, always for this project). The project, temp and package caches never ask.`,
    `  Allowed for good: ${list(view.writesForGood.map(view.show))}. This session only: ${list(view.writesSession.map(view.show))}.`,
    "  To stop being asked: answer 4 at the box, /permissions write <folder> ahead of time, sandbox: allowWrite in config, or --allow-write <folder> for one run. /permissions forget <folder> takes one back.",
    "",
    `Your project's checks (tests, typecheck, lint) run ${view.sandboxOn ? "in the sandbox" : "without a sandbox here"}. Outside the sandbox: ${view.checks === "outside" ? "always (sandbox: checks: outside in ~/.casper/config.yaml)" : view.checks === "inside" ? "never, and never asked (sandbox: checks: inside in ~/.casper/config.yaml)" : view.checksRemembered ? "yes, remembered for this project" : "only if you say so when a check is blocked"}.`,
    "  A check the sandbox blocks asks 'Run this project's checks outside the sandbox?' (not answered by /permissions all). To undo \"always\": /allowed forget <n>.",
    "",
    `Network devices (MCP): every server starts with writes off and each change asks. Writes on now: ${list(view.mcpWritesOn)}. Yes to everything on a product: ${list(view.mcpAllowAll)}.`,
    "  To allow changes: answer 2, 3 or 4 in the change box, or /mcp writes <server> and /mcp allow <server> ahead of time. Ctrl+O turns writes off everywhere.",
    "",
    `Switches (/settings): web lookups ${view.web ? "on" : "off"}, GitHub tool ${view.github ? "on" : "off"}. Fetching ripgrep ${view.downloads ? "on" : "off"} (tools: downloads: off in config).`,
    "",
    "To turn everything on: there is no single switch, on purpose. The closest is /permissions all: until you quit, shell commands, hosts, writes outside the project and other machines are answered Yes for this session (--no-sandbox for one run, or sandbox: off in ~/.casper/config.yaml, takes the shell sandbox away too).",
    "Protected whatever you pick: ~/.ssh, ~/.casper, cloud logins and shell start-up files stay out of the AI's reach; secrets are hidden from the AI; device writes still need the product's own login to allow them and their own box; the spend pause stays; the AI can't answer a box for you.",
    view.scripts,
  ];
  return lines.join("\n");
}

/** What the person typed after /permissions. */
export type PermissionsCommand = { kind: "show" } | { kind: "all" } | { kind: "ask" } | { kind: "write" | "forget"; folder: string };

export function parsePermissions(prompt: string): PermissionsCommand {
  const rest = prompt.replace(/^\/permissions/, "").trim();
  if (!rest) return { kind: "show" };
  if (rest === "all") return { kind: "all" };
  if (rest === "ask") return { kind: "ask" };
  const folder = /^(write|forget)\s+(.+)$/.exec(rest);
  if (folder) return { kind: folder[1] as "write" | "forget", folder: folder[2]!.trim().replace(/^["']|["']$/g, "") };
  throw new Error(PERMISSIONS_USAGE);
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
