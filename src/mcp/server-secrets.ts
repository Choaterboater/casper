/**
 * A key your own MCP server needs: a bearer token or an API key header for a server at an address, or a secret
 * environment variable for a program. You type it in Casper's hidden prompt when the server is added (by /mcp add or
 * the AI's casper_mcp_add, after your yes); the AI never sees it. It is kept in Casper's private file
 * ~/.casper/mcp-secrets.json (0600, never a link), not in ~/.casper/mcp.json, so the server's definition, its hash and
 * its remembered approval don't hold it. It goes only to the server of that name in ~/.casper/mcp.json, when it
 * connects, never to a project's server or one Casper imported, and it is hidden wherever it shows up.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ownPrivateFile, privateFileProblem } from "../platform/private-file";
import type { MCPServerDefinition } from "./config";

export const SECRETS_FILE = ".casper/mcp-secrets.json";
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_VALUE = 8192;
export const DEFAULT_KEY_HEADER = "X-API-Key";

export type ServerKey = { kind: "bearer" } | { kind: "api-key"; header: string } | { kind: "env"; name: string };
/** What a server gets when it connects: headers for one at an address, env for a program. */
export interface ServerSecret { headers: Record<string, string>; env: Record<string, string> }

const HEADER = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
// Headers the connection itself sets; a key can't replace them.
const OWN_HEADERS = /^(?:host|content-.*|connection|transfer-encoding|accept|mcp-.*|cookie|origin)$/i;
const ENV = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// Variables that change how a program starts or what it loads, not a key.
const STARTUP_ENV = /^(?:PATH|HOME|USERPROFILE|SHELL|PWD|TMPDIR|TEMP|TMP|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|LD_.*|DYLD_.*|BUN_.*|COMSPEC|PATHEXT|SYSTEMROOT)$/i;
const VALUE = /^[^\x00-\x1f\x7f]+$/;

export function secretsFile(homeDir: string): string {
  return path.join(homeDir, SECRETS_FILE);
}

/** `bearer`, `api-key`, `api-key:<Header>` or `env:<NAME>`, as the AI's tool and /mcp add's flags name a key. */
export function parseKey(text: string): ServerKey | { error: string } {
  if (text === "bearer") return { kind: "bearer" };
  if (text === "api-key") return { kind: "api-key", header: DEFAULT_KEY_HEADER };
  const header = /^api-key:(.*)$/.exec(text)?.[1];
  if (header !== undefined) {
    return HEADER.test(header) && !OWN_HEADERS.test(header) && !/^authorization$/i.test(header)
      ? { kind: "api-key", header } : { error: `${header || "That"} can't be an API key header (letters, digits and dashes; not one the connection sets)` };
  }
  const name = /^env:(.*)$/.exec(text)?.[1];
  if (name !== undefined) {
    return ENV.test(name) && !STARTUP_ENV.test(name) ? { kind: "env", name } : { error: `${name || "That"} can't be a key's variable (letters, digits and _; not one that changes how a program starts)` };
  }
  return { error: "a key is bearer, api-key, api-key:<Header> or env:<NAME>" };
}

/** The key as /mcp add's flag. */
export function keyFlag(key: ServerKey): string {
  if (key.kind === "bearer") return "--bearer";
  if (key.kind === "api-key") return key.header === DEFAULT_KEY_HEADER ? "--api-key" : `--api-key=${key.header}`;
  return `--key-env=${key.name}`;
}

/** The key in words: "bearer token", "API key (X-API-Key header)", "DOCS_KEY". */
export function keyLabel(key: ServerKey): string {
  if (key.kind === "bearer") return "bearer token";
  if (key.kind === "api-key") return `API key (${key.header} header)`;
  return key.name;
}

/** Why a key can't go with this server, or undefined: a header needs an address and a variable needs a program. */
export function keyProblem(key: ServerKey, atAddress: boolean): string | undefined {
  if (key.kind === "env" && atAddress) return "A server at an address takes --bearer or --api-key, not --key-env.";
  if (key.kind !== "env" && !atAddress) return "A program takes its key as --key-env=<NAME>; --bearer and --api-key are for a server at an address.";
  return undefined;
}

function secretFor(key: ServerKey, value: string): ServerSecret {
  if (key.kind === "bearer") return { headers: { Authorization: `Bearer ${value}` }, env: {} };
  if (key.kind === "api-key") return { headers: { [key.header]: value }, env: {} };
  return { headers: {}, env: { [key.name]: value } };
}

/** Only one-line values under names a key may have. */
function clean(value: unknown): ServerSecret | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const pick = (map: unknown, name: RegExp, banned: RegExp) => Object.fromEntries(Object.entries(map && typeof map === "object" && !Array.isArray(map) ? map : {})
    .filter(([key, text]) => name.test(key) && !banned.test(key) && typeof text === "string" && VALUE.test(text) && text.length <= MAX_VALUE + 7)) as Record<string, string>;
  const record = value as Record<string, unknown>;
  const secret = { headers: pick(record.headers, HEADER, OWN_HEADERS), env: pick(record.env, ENV, STARTUP_ENV) };
  return Object.keys(secret.headers).length || Object.keys(secret.env).length ? secret : undefined;
}

async function readAll(homeDir: string, warn?: (text: string) => void): Promise<Record<string, ServerSecret>> {
  const file = secretsFile(homeDir);
  const leaf = await lstat(file).catch(() => undefined);
  if (!leaf) return {};
  const problem = await privateFileProblem(file).catch(() => "it can't be checked");
  if (problem) {
    warn?.(`Casper's MCP key file isn't used: ${/accessible to other users/.test(problem) ? "it can be read by other users" : problem.replace(/;.*$/, "")}.`);
    return {};
  }
  let parsed: unknown;
  try {
    if (leaf.size > MAX_FILE_BYTES) throw new Error("too large");
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    warn?.("Casper's MCP key file can't be read.");
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, ServerSecret> = {};
  for (const [name, value] of Object.entries(parsed)) {
    const secret = clean(value);
    if (secret) out[name] = secret;
  }
  return out;
}

/** Owner-only, through a temporary file that replaces it. A link, a hard-linked copy or someone else's file is refused. */
async function writeAll(homeDir: string, all: Record<string, ServerSecret>): Promise<void> {
  const file = secretsFile(homeDir);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const problem = await ownPrivateFile(file);
  if (problem) throw new Error(`Casper can't save the key: ${problem}.`);
  if (!Object.keys(all).length) { await rm(file, { force: true }); return; }
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(all, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/** Saves (or replaces) the key of server `name`. */
export async function saveServerKey(homeDir: string, name: string, key: ServerKey, value: string): Promise<void> {
  if (!VALUE.test(value) || value.length > MAX_VALUE) throw new Error("A key is one line of plain text, up to 8192 characters.");
  const all = await readAll(homeDir);
  all[name] = secretFor(key, value);
  await writeAll(homeDir, all);
}

/** Forgets server `name`'s key, so a new server of that name never gets an old one's. */
export async function forgetServerKey(homeDir: string, name: string): Promise<void> {
  if (!await lstat(secretsFile(homeDir)).catch(() => undefined)) return;
  const all = await readAll(homeDir);
  if (!(name in all)) return;
  delete all[name];
  await writeAll(homeDir, all);
}

/** Whether this server gets a saved key: it is in your own ~/.casper/mcp.json, not a profile's, a project's or an
 * imported file's, so no other file can claim the key by using the same name. */
export function getsServerKey(definition: MCPServerDefinition, homeDir: string): boolean {
  return definition.scope === "user" && !definition.importedFrom && definition.source === path.join(homeDir, ".casper", "mcp.json");
}

/** The key server `definition` connects with, or nothing. */
export async function serverKeyFor(definition: MCPServerDefinition, homeDir: string, warn?: (text: string) => void): Promise<ServerSecret> {
  if (!getsServerKey(definition, homeDir)) return { headers: {}, env: {} };
  const secret = (await readAll(homeDir, warn))[definition.name];
  if (!secret) return { headers: {}, env: {} };
  return definition.transport.type === "http" ? { headers: secret.headers, env: {} } : { headers: {}, env: secret.env };
}

/** A secret's values (the token without "Bearer "), to hide. */
export function keyValues(secret: ServerSecret): string[] {
  return [...Object.values(secret.headers), ...Object.values(secret.env)].map((value) => value.replace(/^Bearer\s+/i, "")).filter((value) => value.length >= 4);
}

/** Every saved key's value, read at once, to hide in what the AI reads. A file that can't be read gives none. */
export function savedKeyValues(homeDir: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(secretsFile(homeDir), "utf8")) as Record<string, unknown>;
    return Object.values(parsed).flatMap((value) => { const secret = clean(value); return secret ? keyValues(secret) : []; });
  } catch { return []; }
}
