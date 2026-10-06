import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { MCPServerDefinition } from "../config";
import { matchPreset } from "../presets";

/**
 * What a local MCP server needs, when Casper knows it: the folders it reads in your home folder, the one folder it
 * writes, and the hosts it reaches. A server with a profile runs in the same sandbox as the AI's shell, held to it.
 * Every other server runs as before (unsandboxed, with its approvals), so a working server never breaks.
 *
 * Today one server has a profile: Casper's own casper-network-mcp, installed as a Python venv (Casper's own
 * ~/.casper/tools entry, or one you built). It reads only that venv and the Python it was built with, writes only its
 * spec cache (~/.cache/casper-network-mcp), and reaches only the product hosts of your saved logins.
 */

export interface ServerProfile {
  /** Which profile: the preset id it comes from. */
  id: string;
  /** Folders it may read inside places that are otherwise hidden (its install, its Python). */
  reads: string[];
  /** Its own cache folder: the one place it writes (besides its own temp folder). */
  cache: string;
  /** Hosts it may reach, through Casper's proxy. Empty: no network at all. */
  hosts: string[];
}

/** The Central login's token host: every Central login gets its token there. */
export const CENTRAL_TOKEN_HOST = "sso.common.cloud.hpe.com";

/** The login variables that name a product host (casper-network-mcp core/logins.py). */
const HOST_ENV = ["MIST_HOST", "CENTRAL_BASE_URL", "CLEARPASS_BASE_URL"] as const;

/** Names of proxy settings: a server that sets its own goes through that proxy, so Casper can't hold its network. */
const PROXY_ENV = /^(https?|all)_proxy$/i;

/** The hosts the network server's saved logins need: each product's host, and Central's token host. */
export function loginHosts(logins: Record<string, string>): string[] {
  const hosts = new Set<string>();
  for (const name of HOST_ENV) {
    const value = logins[name];
    if (!value) continue;
    try { hosts.add(new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, "")); } catch { /* not an address: no host */ }
  }
  if (logins.CENTRAL_BASE_URL) hosts.add(CENTRAL_TOKEN_HOST);
  return [...hosts].filter(Boolean);
}

/** The venv a program sits in (`<venv>/bin/<entry>` with `<venv>/pyvenv.cfg`), and the Python it was built from. */
export function venvOf(command: string, platform: NodeJS.Platform = process.platform): { venv: string; pythonHome?: string } | undefined {
  if (!path.isAbsolute(command)) return undefined;
  const bin = path.dirname(command);
  if (path.basename(bin) !== (platform === "win32" ? "Scripts" : "bin")) return undefined;
  const venv = path.dirname(bin);
  let config: string;
  try {
    if (!statSync(path.join(venv, "pyvenv.cfg")).isFile()) return undefined;
    config = readFileSync(path.join(venv, "pyvenv.cfg"), "utf8");
  } catch { return undefined; }
  // `home = /…/cpython-3.12.x/bin`: the Python's own folder is the one above.
  const home = /^\s*home\s*=\s*(.+?)\s*$/m.exec(config)?.[1];
  const pythonHome = home && path.isAbsolute(home) ? (path.basename(home) === "bin" ? path.dirname(home) : home) : undefined;
  return { venv, ...(pythonHome ? { pythonHome } : {}) };
}

/** Why a server has no profile, in a few words for /mcp; undefined when it has one. */
export type ProfileResult = { profile: ServerProfile } | { none: string };

/**
 * The profile for a server, or why it has none. `logins` is the env Casper starts it with (the saved logins, for the
 * network server). Only a stdio server recognised by its definition can have one, and only when it runs a program
 * Casper can place (an installed venv): a package runner or a container needs much more than Casper can list.
 */
export function serverProfile(definition: MCPServerDefinition, options: { home: string; logins: Record<string, string>; platform?: NodeJS.Platform }): ProfileResult {
  if (definition.transport.type !== "stdio") return { none: "remote" };
  const match = matchPreset(definition);
  if (match?.preset.id !== "casper-network-mcp" || match.by !== "definition") return { none: "Casper doesn't know what it needs" };
  if (Object.keys(definition.transport.env).some((name) => PROXY_ENV.test(name))) return { none: "it sets its own proxy" };
  const found = venvOf(definition.transport.command, options.platform);
  if (!found) return { none: "it doesn't run from an installed venv" };
  return {
    profile: {
      id: match.preset.id,
      reads: [found.venv, ...(found.pythonHome ? [found.pythonHome] : [])],
      cache: path.join(options.home, ".cache", "casper-network-mcp"),
      hosts: loginHosts(options.logins),
    },
  };
}
