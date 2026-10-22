/**
 * /mcp add: a server you name on one line, written to ~/.casper/mcp.json and connected at once, the way /mcp setup ssh
 * does it. `/mcp add <name> <command> [args…]` is a program Casper starts on this computer; `/mcp add <name> <url>` is
 * one at an address. Only the person types it; the AI can't run a slash command.
 *
 * The words are split as a shell splits them (quotes keep spaces in a word), but nothing is expanded or run: `${NAME}`
 * stays as typed and is filled in when the server connects (docs/MCP.md, "Variables"). A backslash outside quotes is
 * kept as typed, so a Windows path needs no doubling.
 */

import { terminalText } from "../tui/format";
import { plainHttpHost, serverEntryProblem, type MCPServerDefinition } from "./config";
import { addUserServer, MCP_FILE_LABEL, ServerExistsError, type UserServerEntry } from "./docs";

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const MAX_LINE = 4096;

export const MCP_ADD_EXAMPLE = "/mcp add docs npx -y @example/docs-mcp@1.2.0";
/** What `/mcp add` alone says: the two forms and an example, at the normal level. */
export const MCP_ADD_HINT = `Add a server: /mcp add <name> <command> [args…], such as ${MCP_ADD_EXAMPLE}, or /mcp add <name> <https://address>. `
  + `It goes in ${MCP_FILE_LABEL} and starts now.`;

export type McpAddEntry = { command: string; args: string[] } | { url: string };
export interface McpAdd { name: string; entry: McpAddEntry }
export type McpAddResult = "added" | "exists" | "failed";

export interface McpAddHost {
  homeDir: string;
  write(text: string): void;
  /** Every server Casper knows now, from any file: a name one of them has is never taken. */
  configured(): Promise<ReadonlyArray<MCPServerDefinition | undefined>>;
  /** Re-reads the files and connects `name` (as /mcp setup ssh does): ok, or why it didn't start. */
  connect(name: string): Promise<{ ok: boolean; message?: string }>;
}

/** A line's words as a shell splits them, without expanding or running anything: '…' keeps everything in it, "…"
 * keeps everything but turns \" and \\ into " and \, and a backslash outside quotes is an ordinary character.
 * Undefined when a quote isn't closed. */
export function splitWords(text: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote === "'") { if (char === "'") quote = undefined; else word += char; continue; }
    if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (char === "\\" && (text[index + 1] === '"' || text[index + 1] === "\\")) word += text[++index];
      else word += char;
      continue;
    }
    if (/\s/.test(char)) { if (started) words.push(word); word = ""; started = false; continue; }
    started = true;
    if (char === "'" || char === '"') quote = char;
    else word += char;
  }
  if (quote) return undefined;
  if (started) words.push(word);
  return words;
}

/** One word as splitWords reads it back: bare when it can be, else quoted. */
function shellWord(word: string): string {
  if (word && !/[\s'"]/.test(word)) return word;
  return word.includes("'") ? `"${word.replace(/["\\]/g, "\\$&")}"` : `'${word}'`;
}

/** What the server runs, as you would type it: `npx -y example-mcp@1.4.2`, or its address. */
export function entryText(entry: McpAddEntry): string {
  return "url" in entry ? entry.url : [entry.command, ...entry.args].map(shellWord).join(" ");
}

/** The exact /mcp add line for a server, which splitWords reads back to the same words. */
export function mcpAddLine({ name, entry }: McpAdd): string {
  return `/mcp add ${name} ${entryText(entry)}`;
}

/** Why an address can't be a server's: the rules ~/.casper/mcp.json has for one, and a GitHub page, which is where a
 * server's code is, not where it answers. */
export function addressProblem(text: string): string | undefined {
  let url: URL;
  try { url = new URL(text); } catch { return "That isn't an address Casper can read."; }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && plainHttpHost(url.hostname))) {
    return "An address must be https://, or http:// to this computer or your own network (such as 192.168.x.x or a .local name).";
  }
  if (url.username || url.password || url.hash) return "An address can't hold a user name, a password or a #fragment.";
  if (/^(?:www\.)?github\.com$/i.test(url.hostname)) {
    return "That is a GitHub page, not a server's address. Add the command that starts the server (its README says it), "
      + "such as /mcp add <name> npx -y <package>@<version>.";
  }
  return undefined;
}

const NAME_RULE = "A server name is letters, digits, dot, dash or underscore, up to 64, and starts with a letter or digit.";

/** Why a server can't be added as given (by /mcp add or the AI's casper_mcp_add), or undefined when it can. */
export function mcpAddProblem({ name, entry }: McpAdd): string | undefined {
  if (!NAME.test(name)) return NAME_RULE;
  const words = "url" in entry ? [entry.url] : [entry.command, ...entry.args];
  if (words.join(" ").length > MAX_LINE || words.some((word) => /[\x00-\x1f\x7f]/.test(word))) return "That line can't be used (one line, up to 4096 characters).";
  if ("url" in entry) return addressProblem(entry.url);
  if (!entry.command.trim()) return "The command that starts the server is missing.";
  return undefined;
}

/** The words after `/mcp add`: a name and a command with its words, or a name and an address. `usage` when either is
 * missing; otherwise the reason it can't be used. */
export function parseMcpAdd(text: string): McpAdd | { error: string } {
  if (text.length > MAX_LINE || /[\x00-\x1f\x7f]/.test(text)) return { error: "That line can't be used (one line, up to 4096 characters)." };
  const words = splitWords(text);
  if (!words) return { error: "A quote isn't closed." };
  const [name, target, ...args] = words;
  if (!name || !target) return { error: "usage" };
  if (!NAME.test(name)) return { error: NAME_RULE };
  if (!args.length && /^(?:[a-z0-9.-]+|\[[0-9a-f:]+\]):\d{1,5}(?:\/\S*)?$/i.test(target)) {
    return { error: `That looks like an address, so it needs http:// or https:// in front: /mcp add ${name} http://${target} (or https://).` };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) && args.length) return { error: "An address takes nothing after it: /mcp add <name> <url>." };
  const add: McpAdd = /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? { name, entry: { url: target } } : { name, entry: { command: target, args } };
  const problem = mcpAddProblem(add);
  return problem ? { error: problem } : add;
}

/** The entry as ~/.casper/mcp.json holds it. */
function fileEntry(entry: McpAddEntry): UserServerEntry {
  return "url" in entry ? { url: entry.url } : { command: entry.command, args: [...entry.args], env: {} };
}

/** Writes the server to ~/.casper/mcp.json, never over a name a server already has in any file Casper reads, and
 * connects it. Says what happened at each step. */
export async function runMcpAdd(host: McpAddHost, add: McpAdd): Promise<McpAddResult> {
  const { name, entry } = add;
  const taken = (await host.configured()).find((definition) => definition?.name === name);
  if (taken) {
    host.write(`[mcp] ${name} is already a server (${terminalText(taken.source)}). Pick another name. Nothing changed.\n`);
    return "exists";
  }
  const written = fileEntry(entry);
  // The same reading Casper gives the file at the next start, so what is written always loads.
  const problem = serverEntryProblem(name, "url" in written ? { type: "http", url: written.url } : written);
  if (problem) { host.write(`[mcp] ${name} can't be added (${problem}). Nothing changed.\n`); return "failed"; }
  try {
    await addUserServer(host.homeDir, name, written);
  } catch (error) {
    host.write(`[mcp] ${terminalText(error instanceof Error ? error.message : String(error))}\n`);
    return error instanceof ServerExistsError ? "exists" : "failed";
  }
  host.write(`[mcp] Added ${name} to ${MCP_FILE_LABEL}: ${terminalText(entryText(entry))}. Starting it…\n`);
  let connected: { ok: boolean; message?: string };
  try { connected = await host.connect(name); }
  catch (error) { connected = { ok: false, message: error instanceof Error ? error.message : String(error) }; }
  if (!connected.ok) {
    host.write(`[mcp] ${name} is in ${MCP_FILE_LABEL} but didn't start${connected.message ? `: ${terminalText(connected.message)}` : ""}.\n`
      + `Fix that, then type /mcp connect ${name}.\n`);
    return "failed";
  }
  return "added";
}
