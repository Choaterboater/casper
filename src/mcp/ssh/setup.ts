import { readFile } from "node:fs/promises";
import path from "node:path";
import { numberedLines, sshHostChoices, sshNameChoices } from "../../app/safe-choices";
import { terminalText } from "../../tui/format";
import { accessStatusText, type AccessCheck } from "../access";
import { addUserServer, MCP_FILE_LABEL, ServerExistsError, type DocsOnlyEntry } from "../docs";
import type { SetupHost } from "../network/setup";

/**
 * /mcp setup ssh: an MCP server that runs on another machine, started there over ssh (stdio). Casper asks which ssh
 * host (a numbered pick from ~/.ssh/config), takes the remote command and a short name, writes the entry to
 * ~/.casper/mcp.json itself and connects it with writes off. Casper has no plain text box (its login box hides what
 * you type), so a host, command or name that has to be typed goes on the /mcp setup ssh line, and Casper says that
 * line. Only the person answers; the AI can't run a slash command.
 */

/** Hosts listed from ~/.ssh/config, so every choice is one key (1 Not now, the hosts, then Type a host). */
const MAX_LISTED = 7;
const MAX_COMMAND = 4096;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const EXAMPLE_COMMAND = "python3 -m my_server mcp";

export type SshSetupResult = "not-now" | "needs-command" | "added" | "exists" | "failed" | "cant-ask";

export interface SshSetupHost extends Pick<SetupHost, "homeDir" | "canAsk" | "chooseAnswer" | "write" | "configured" | "connect"> {
  /** The server's access_check answer on its new connection, when it has one. */
  access?(name: string): AccessCheck | undefined;
}

export interface SshSetupOptions { name?: string; sshHost?: string; command?: string }

/** The server entry: ssh with no prompts (a prompt would hang the server's start), `--` so nothing after it is read as
 * an ssh option, the remote command as one word, and the ssh agent passed on. */
export function sshEntry(sshHost: string, command: string): DocsOnlyEntry {
  return { command: "ssh", args: ["-T", "-o", "BatchMode=yes", "--", sshHost, command], env: { SSH_AUTH_SOCK: "${SSH_AUTH_SOCK:-}" } };
}

/** A host as ssh takes it: a name from ~/.ssh/config, an address, or user@either. Never one that starts with "-", which
 * ssh would read as an option. */
export function isSshHost(value: string): boolean {
  return /^[A-Za-z0-9_[][A-Za-z0-9._@:%[\]-]{0,252}$/.test(value);
}

/** The default server name: the host without its user, in the letters a server name may use. */
export function defaultServerName(sshHost: string): string {
  const name = sshHost.slice(sshHost.lastIndexOf("@") + 1).replace(/[^A-Za-z0-9_.-]/g, "-").replace(/^[^A-Za-z0-9]+|-+$/g, "").slice(0, 64);
  return NAME.test(name) ? name : "ssh-server";
}

/** The plain `Host` names in ~/.ssh/config (no patterns), in file order. A missing file has none. */
export async function sshConfigHosts(homeDir: string): Promise<string[]> {
  let text: string;
  try { text = await readFile(path.join(homeDir, ".ssh", "config"), "utf8"); } catch { return []; }
  const hosts: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const found = /^\s*Host\s*[=\s]\s*(.+?)\s*$/i.exec(line);
    if (!found) continue;
    for (const name of found[1]!.replace(/#.*$/, "").split(/\s+/)) {
      if (name && !/[*?!]/.test(name) && isSshHost(name) && !hosts.includes(name)) hosts.push(name);
    }
  }
  return hosts;
}

/** The words typed after /mcp setup ssh: `[--name <name>] [host] [command …]`. The command is everything after the
 * host, kept as typed. */
export function parseSshSetup(text: string): SshSetupOptions | { error: "usage" } {
  let rest = text.trim();
  const options: SshSetupOptions = {};
  const named = /^--name(?:\s+(\S+))?(?:\s+|$)/.exec(rest);
  if (named) {
    if (!named[1]) return { error: "usage" };
    options.name = named[1];
    rest = rest.slice(named[0].length);
  }
  const hostWord = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest);
  if (hostWord) {
    options.sshHost = hostWord[1]!;
    const command = hostWord[2]?.trim();
    if (command) options.command = command;
  }
  return options;
}

const INTRO = "Casper can add an MCP server that runs on another machine. It starts the server there over ssh, with writes off.";

/** The ssh host picked from the list; undefined for Not now or nobody answering; null for Type a host. */
async function askHost(host: SshSetupHost): Promise<string | undefined | null> {
  const listed = (await sshConfigHosts(host.homeDir)).slice(0, MAX_LISTED);
  const labels = sshHostChoices(listed);
  const digits = labels.map((_label, index) => String(index + 1));
  const answer = await host.chooseAnswer(`${INTRO}\nWhich ssh host?\n${numberedLines(labels)}`, `Type 1-${digits.length}: `, digits);
  const index = answer === undefined ? 0 : digits.indexOf(answer);
  if (index <= 0) return undefined;
  return index <= listed.length ? listed[index - 1] : null;
}

/** The name picked: the default (2); undefined for Not now or nobody answering; null for Type a name. */
async function askName(host: SshSetupHost, sshHost: string, command: string): Promise<string | undefined | null> {
  const name = defaultServerName(sshHost);
  const preview = `Casper adds this to ${MCP_FILE_LABEL} and connects it with writes off:\n  ssh ${sshHost} ${terminalText(command)}\n`
    + `Name it?\n${numberedLines(sshNameChoices(name))}`;
  const answer = await host.chooseAnswer(preview, "Type 1-3: ", ["1", "2", "3"]);
  return answer === "2" ? name : answer === "3" ? null : undefined;
}

const NOT_NOW = "Nothing added. Type /mcp setup ssh any time.\n";

export async function runSshSetup(host: SshSetupHost, options: SshSetupOptions = {}): Promise<SshSetupResult> {
  if (!host.canAsk()) { host.write("This run can't ask you. Run casper and type /mcp setup ssh to add a server that runs over ssh.\n"); return "cant-ask"; }
  if (options.name !== undefined && !NAME.test(options.name)) {
    host.write("A name is letters, digits, dot, dash or underscore, up to 64. Nothing changed.\n");
    return "failed";
  }
  const sshHost = options.sshHost === undefined ? await askHost(host) : options.sshHost;
  if (sshHost === null) { host.write(`Type /mcp setup ssh <host> <command>, such as /mcp setup ssh admin@192.0.2.10 ${EXAMPLE_COMMAND}\n`); return "not-now"; }
  if (sshHost === undefined) { host.write(NOT_NOW); return "not-now"; }
  if (!isSshHost(sshHost)) { host.write("That isn't an ssh host name (one that starts with - is never used). Nothing changed.\n"); return "failed"; }
  const command = options.command;
  if (command === undefined) {
    host.write(`Now type the command that starts the MCP server on ${sshHost}: /mcp setup ssh ${sshHost} <command>, such as /mcp setup ssh ${sshHost} ${EXAMPLE_COMMAND}\n`);
    return "needs-command";
  }
  if (command.length > MAX_COMMAND || /[\x00-\x1f\x7f]/.test(command)) { host.write("That command can't be used (one line, up to 4096 characters). Nothing changed.\n"); return "failed"; }
  const name = options.name ?? await askName(host, sshHost, command);
  if (name === null) { host.write(`Type /mcp setup ssh --name <name> ${sshHost} ${terminalText(command)}\n`); return "not-now"; }
  if (name === undefined) { host.write(NOT_NOW); return "not-now"; }
  try {
    await addUserServer(host.homeDir, name, sshEntry(sshHost, command));
  } catch (error) {
    host.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof ServerExistsError ? "exists" : "failed";
  }
  let connected: { ok: boolean; message?: string };
  try { connected = await host.connect(name); }
  catch (error) { connected = { ok: false, message: error instanceof Error ? error.message : String(error) }; }
  if (!connected.ok) {
    host.write(`${name} is added (ssh ${sshHost}) but didn't start${connected.message ? `: ${terminalText(connected.message)}` : ""}.\n`
      + `Check that \`ssh ${sshHost}\` logs in with no password prompt and that the command starts the server there, then type /mcp connect ${name}.\n`);
    return "failed";
  }
  host.write(`${name} ready (writes off, ssh ${sshHost}, ${accessStatusText(host.access?.(name))}). /mcp writes ${name} lets changes through.\n`);
  return "added";
}
