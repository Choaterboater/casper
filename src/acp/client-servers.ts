// The MCP servers an ACP client lists in session/new or session/load (decision 77). They connect for that session
// only, as scope "client": in memory, never written to a file or remembered, with no saved keys or logins and no
// ${VAR} expansion. Names start acp- and never replace a server from a file Casper reads. A stdio one starts in the
// absolute folder its casper/cwd names, else in your home folder (decision 89).

import path from "node:path";
import { isIP } from "node:net";
import { clientSecretParts, entryDefinition, entryReason, type MCPConfiguration, type MCPServerDefinition } from "../mcp/config";
import type { AcpMcpSetting } from "../config/load";

// acp_mcp (~/.casper/config.yaml): on, the client's servers connect, and one the client says asks for itself
// (casper/clientAsks) gets no Casper change box; ask, they connect and every change asks in Casper's box; off, none
// connects, as before decision 77. Either way only a server the client marks so (on this computer, or a program it
// runs) is its own (clientOwned): it alone may pin tools and hear the step a call is (decision 89).

/** At most this many servers from one client. */
export const MAX_CLIENT_SERVERS = 8;
/** What /mcp and the notes say a client server came from. */
export const CLIENT_SOURCE = "the app (ACP)";

export interface ClientServers {
  definitions: MCPServerDefinition[];
  /** Every header and env value the client gave (and its URL-encoded form), for hiding them in updates, the receipt
   * and results. */
  secrets: string[];
  /** One line per server, never with a value. */
  notes: string[];
}

type Json = Record<string, unknown>;

// Variables that change how a program starts (as for keys, decision 31).
const STARTUP_ENV = /^(?:PATH|NODE_OPTIONS|LD_.*|DYLD_.*)$/i;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
// Headers the connection itself sets.
const OWN_HEADERS = /^(?:host|content-.*|connection|transfer-encoding|mcp-.*|cookie|origin)$/i;
const NAME = /^[a-zA-Z0-9_.-]{1,60}$/;

class Refused extends Error {}

/** This computer only: what a client's "asks for itself" counts for over http (a server the client runs). */
function loopback(url: string): boolean {
  const host = new URL(url).hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  return host === "localhost" || host === "::1" || (isIP(host) === 4 && host === "127.0.0.1");
}

/** ACP's [{name, value}] list as a map, with each name checked. */
function pairs(value: unknown, check: (name: string) => string | undefined): Record<string, string> {
  if (value === undefined) return {};
  if (!Array.isArray(value)) throw new Refused("invalid list");
  const map: Record<string, string> = {};
  for (const pair of value as Json[]) {
    if (!pair || typeof pair !== "object" || typeof pair.name !== "string" || typeof pair.value !== "string") throw new Refused("invalid list");
    const problem = check(pair.name);
    if (problem) throw new Refused(problem);
    map[pair.name] = pair.value;
  }
  return map;
}

function envName(name: string): string | undefined {
  if (!ENV_NAME.test(name)) return "invalid env name";
  return STARTUP_ENV.test(name) ? `${name} cannot be set` : undefined;
}

function headerName(name: string): string | undefined {
  if (!HEADER_NAME.test(name)) return "invalid header name";
  return OWN_HEADERS.test(name) ? `the connection sets ${name}` : undefined;
}

function oneServer(entry: Json, name: string, home: string, setting: AcpMcpSetting): MCPServerDefinition {
  const type = entry.type;
  const meta = entry._meta && typeof entry._meta === "object" ? entry._meta as Json : {};
  const owned = meta["casper/clientAsks"] === true;
  const asks = owned && setting === "on";
  if (type === "sse") throw new Refused("SSE is not supported");
  if (type === "http") {
    if (typeof entry.url !== "string") throw new Refused("invalid URL");
    const headers = pairs(entry.headers, headerName);
    let definition: MCPServerDefinition;
    try { definition = entryDefinition(name, { type: "http", url: entry.url, headers }, CLIENT_SOURCE, home); }
    catch (error) { throw new Refused(entryReason(error) ?? "invalid URL"); }
    const here = definition.transport.type === "http" && loopback(definition.transport.url);
    return { ...definition, scope: "client", ...(owned && here ? { clientOwned: true as const } : {}), ...(asks && here ? { clientAsks: true as const } : {}) };
  }
  if (type !== undefined && type !== "stdio") throw new Refused("unsupported transport");
  if (typeof entry.command !== "string" || !path.isAbsolute(entry.command)) throw new Refused("the command must be an absolute path");
  const args = entry.args ?? [];
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new Refused("invalid args");
  const env = pairs(entry.env, envName);
  // The folder the app runs it in, as an absolute path only: never a project's or one read against Casper's own.
  const cwd = meta["casper/cwd"];
  if (cwd !== undefined && (typeof cwd !== "string" || !path.isAbsolute(cwd))) throw new Refused("cwd must be an absolute path");
  let definition: MCPServerDefinition;
  try { definition = entryDefinition(name, { command: entry.command, args, env }, CLIENT_SOURCE, cwd === undefined ? home : path.normalize(cwd)); }
  catch (error) { throw new Refused(entryReason(error) ?? "invalid definition"); }
  return { ...definition, scope: "client", ...(owned ? { clientOwned: true as const } : {}), ...(asks ? { clientAsks: true as const } : {}) };
}

/** The client's `mcpServers` list as definitions for this session, with a note for each (values never shown). */
export function clientServers(entries: unknown, options: { home: string; setting: AcpMcpSetting }): ClientServers {
  const result: ClientServers = { definitions: [], secrets: [], notes: [] };
  if (!Array.isArray(entries)) return result;
  const taken = new Set<string>();
  entries.forEach((raw, index) => {
    const entry = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Json : {};
    const given = typeof entry.name === "string" && NAME.test(entry.name) ? entry.name : undefined;
    const label = given ? `acp-${given}` : `number ${index + 1}`;
    const refuse = (reason: string) => { result.notes.push(`[acp] The app's MCP server ${label} is not connected: ${reason}.`); };
    if (options.setting === "off") return refuse("acp_mcp is off");
    if (!given) return refuse("invalid name");
    const name = `acp-${given}`;
    if (taken.has(name)) return refuse("another server has that name");
    taken.add(name);
    if (result.definitions.length >= MAX_CLIENT_SERVERS) return refuse(`at most ${MAX_CLIENT_SERVERS} servers`);
    try {
      const definition = oneServer(entry, name, options.home, options.setting);
      const transport = definition.transport;
      const secrets = Object.values(transport.type === "http" ? transport.headers : transport.env).flatMap(clientSecretParts).filter((value) => value.length > 0);
      // Kept only once its secrets are known, so a refused server never stays in the list.
      result.definitions.push(definition);
      result.secrets.push(...secrets);
      result.notes.push(`[acp] The app's MCP server ${name} connects for this session.`);
    } catch (error) {
      refuse(error instanceof Refused ? error.message : "invalid definition");
    }
  });
  return result;
}

/** The discovered servers plus the client's: one whose name a file already uses is left out, so it never replaces it. */
export function withClientServers(definitions: readonly MCPServerDefinition[]): (configuration: MCPConfiguration) => MCPConfiguration {
  return (configuration) => {
    const names = new Set(configuration.servers.map((server) => server.name));
    const diagnostics = [...configuration.diagnostics];
    const added: MCPServerDefinition[] = [];
    for (const definition of definitions) {
      if (names.has(definition.name)) {
        diagnostics.push(`${definition.name}: the app's server is not used: a file Casper reads has a server of that name.`);
        continue;
      }
      added.push(structuredClone(definition));
    }
    return { servers: [...configuration.servers, ...added].sort((a, b) => a.name.localeCompare(b.name)), diagnostics };
  };
}
