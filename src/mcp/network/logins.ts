import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ownPrivateFile, privateFileProblem } from "../../platform/private-file";
import { resolveEnvironment, type MCPServerDefinition } from "../config";
import { matchPreset } from "../presets";

/**
 * Logins for Casper's network server, one per product, kept in Casper's own private file
 * (~/.casper/network-logins.json, 0600, never a link). They go into the server's start env only; they are
 * never in ~/.casper/mcp.json, so the server's definition, its hash and its remembered approval don't move
 * when a login is added, changed or forgotten. The AI's file tools and shell can't read the file, and its
 * values are hidden wherever they show up.
 */

export type NetworkProduct = "mist" | "central" | "clearpass";
export const NETWORK_PRODUCTS: readonly NetworkProduct[] = ["mist", "central", "clearpass"];
export const PRODUCT_LABELS: Record<NetworkProduct, string> = { mist: "Mist", central: "Central", clearpass: "ClearPass" };

export const LOGIN_FILE = ".casper/network-logins.json";

export interface LoginField {
  key: string;
  /** The server's login variable (casper-network-mcp core/logins.py). */
  env: string;
  label: string;
  secret: boolean;
  /** Picked by number instead of typed. */
  choices?: { label: string; value: string }[];
  /** The last choice, "Other — type the address": then this is asked as a typed address. */
  other?: string;
}

/** The Mist clouds, in the order of the `servers` list of the Mist spec the server bundles. */
const MIST_CLOUDS: [string, string][] = [
  ["Global 01", "api.mist.com"], ["Global 02", "api.gc1.mist.com"], ["Global 03", "api.ac2.mist.com"], ["Global 04", "api.gc2.mist.com"],
  ["Global 05", "api.gc4.mist.com"], ["EMEA 01", "api.eu.mist.com"], ["EMEA 02", "api.gc3.mist.com"], ["EMEA 03", "api.ac6.mist.com"],
  ["EMEA 04", "api.gc6.mist.com"], ["APAC 01", "api.ac5.mist.com"], ["APAC 02", "api.gc5.mist.com"], ["APAC 03", "api.gc7.mist.com"],
];
/** The Central regions from the `servers` list of the Central specs the server bundles (the internal one last, before China). */
const CENTRAL_REGIONS: [string, string][] = [
  ["US 1", "us1"], ["US 2", "us2"], ["US 4", "us4"], ["US 5", "us5"], ["US 6", "us6"], ["Canada 1", "ca1"], ["EU 1", "de1"], ["EU 2", "de2"],
  ["EU 3", "de3"], ["UK 1", "gb1"], ["India 1", "in1"], ["Japan 1", "jp1"], ["Australia 1", "au1"], ["UAE 1", "ae1"],
];

export const LOGIN_FIELDS: Record<NetworkProduct, LoginField[]> = {
  mist: [
    { key: "host", env: "MIST_HOST", label: "Mist cloud", secret: false,
      choices: MIST_CLOUDS.map(([name, host]) => ({ label: `${name} (${host})`, value: `https://${host}` })), other: "Mist API address (https://…)" },
    { key: "token", env: "MIST_API_TOKEN", label: "Mist API token", secret: true },
  ],
  central: [
    { key: "base_url", env: "CENTRAL_BASE_URL", label: "Central region", secret: false,
      choices: [
        ...CENTRAL_REGIONS.map(([name, code]) => ({ label: `${name} (${code}.api.central.arubanetworks.com)`, value: `https://${code}.api.central.arubanetworks.com` })),
        { label: "Internal (internal.api.central.arubanetworks.com)", value: "https://internal.api.central.arubanetworks.com" },
        { label: "China 1 (cn1.api.central.arubanetworks.com.cn)", value: "https://cn1.api.central.arubanetworks.com.cn" },
      ], other: "Central API address (https://…)" },
    { key: "client_id", env: "CENTRAL_CLIENT_ID", label: "Central API client ID", secret: false },
    { key: "client_secret", env: "CENTRAL_CLIENT_SECRET", label: "Central API client secret", secret: true },
  ],
  clearpass: [
    { key: "base_url", env: "CLEARPASS_BASE_URL", label: "ClearPass address (https://…)", secret: false },
    { key: "token", env: "CLEARPASS_API_TOKEN", label: "ClearPass API token", secret: true },
  ],
};

/** Values hidden from the AI and from the server's output: the secrets, and the Central client ID. */
const HIDDEN_ENV = new Set(["MIST_API_TOKEN", "CENTRAL_CLIENT_ID", "CENTRAL_CLIENT_SECRET", "CLEARPASS_API_TOKEN"]);
const URL_ENV = new Set(["MIST_HOST", "CENTRAL_BASE_URL", "CLEARPASS_BASE_URL"]);

/**
 * A named Central login's name: lowercase letters and digits, at most 32 (casper-network-mcp 0.1.6 reads
 * CENTRAL_<NAME>_BASE_URL, _CLIENT_ID and _CLIENT_SECRET with NAME in [A-Z0-9]{1,32}). "default" is the main login
 * and "forget" is the word that removes one, so neither can be a name.
 */
export const LOGIN_NAME = /^[a-z0-9]{1,32}$/;
const RESERVED_NAMES = new Set(["default", "forget"]);
/** The start env name of a named login's field: CENTRAL_BASE_URL → CENTRAL_ACME_BASE_URL. */
const NAMED_ENV = /^CENTRAL_[A-Z0-9]{1,32}_(BASE_URL|CLIENT_ID|CLIENT_SECRET)$/;

export function isLoginName(value: unknown): value is string {
  return typeof value === "string" && LOGIN_NAME.test(value) && !RESERVED_NAMES.has(value);
}

function namedEnv(name: string, env: string): string {
  return env.replace(/^CENTRAL_/, `CENTRAL_${name.toUpperCase()}_`);
}
const VALUE = /^[\x21-\x7e]{1,4096}$/;
const MAX_FILE_BYTES = 64 * 1024;

export type Logins = Partial<Record<NetworkProduct, Record<string, string>>>;
/** Named Central logins, by name: each holds the same fields as the main Central login (CENTRAL_BASE_URL, …). */
export type NamedLogins = Record<string, Record<string, string>>;
/** Where named Central logins sit in the file, beside the products. */
const NAMED_KEY = "central_logins";

export function isNetworkProduct(value: unknown): value is NetworkProduct {
  return typeof value === "string" && (NETWORK_PRODUCTS as readonly string[]).includes(value);
}

export function loginFile(homeDir: string): string {
  return path.join(homeDir, LOGIN_FILE);
}

/** Why a value can't be a login value, or undefined. Addresses must be https, with no name or password in them. */
function valueProblem(env: string, value: unknown): string | undefined {
  if (typeof value !== "string" || !VALUE.test(value)) return "only one line of plain text";
  if (!URL_ENV.has(env)) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return "an https:// address"; }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) return "an https:// address";
  return undefined;
}

/** Only the product's own fields with good values. */
function clean(product: NetworkProduct, values: unknown): Record<string, string> {
  if (!values || typeof values !== "object" || Array.isArray(values)) return {};
  const kept: Record<string, string> = {};
  for (const field of LOGIN_FIELDS[product]) {
    const value = (values as Record<string, unknown>)[field.env];
    if (!valueProblem(field.env, value)) kept[field.env] = value as string;
  }
  return kept;
}

/** Each problem with the file is said once per Casper run, not on every server start. */
const said = new Set<string>();
function sayOnce(warn: ((text: string) => void) | undefined, text: string): void {
  if (!warn || said.has(text)) return;
  said.add(text);
  warn(text);
}

/** The saved logins. A file that is a link, not yours, or readable by other users is not used (and said once). */
export async function readLogins(homeDir: string, warn?: (text: string) => void): Promise<Logins> {
  return (await readLoginFile(homeDir, warn)).logins;
}

/** The saved named Central logins, by name (complete ones only). */
export async function readNamedLogins(homeDir: string, warn?: (text: string) => void): Promise<NamedLogins> {
  return (await readLoginFile(homeDir, warn)).named;
}

async function readLoginFile(homeDir: string, warn?: (text: string) => void): Promise<{ logins: Logins; named: NamedLogins }> {
  const none = { logins: {}, named: {} };
  const file = loginFile(homeDir);
  const leaf = await lstat(file).catch(() => undefined);
  if (!leaf) return none;
  const problem = await privateFileProblem(file).catch(() => "it can't be checked");
  if (problem) {
    const why = /accessible to other users/.test(problem) ? "it can be read by other users" : problem.replace(/;.*$/, "");
    sayOnce(warn, `Casper's network login file isn't used: ${why}. Type /mcp login <product> to save the login again, privately.`);
    return none;
  }
  let parsed: unknown;
  try {
    if (leaf.size > MAX_FILE_BYTES) throw new Error("too large");
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    sayOnce(warn, "Casper's network login file can't be read. Type /mcp login <product> to save the login again.");
    return none;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return none;
  const logins: Logins = {};
  for (const product of NETWORK_PRODUCTS) {
    const values = clean(product, (parsed as Record<string, unknown>)[product]);
    if (Object.keys(values).length) logins[product] = values;
  }
  const named: NamedLogins = {};
  const saved = (parsed as Record<string, unknown>)[NAMED_KEY];
  if (saved && typeof saved === "object" && !Array.isArray(saved)) {
    for (const [name, values] of Object.entries(saved)) {
      const kept = clean("central", values);
      // Only a whole login: a named one has no main login to borrow a missing field from.
      if (isLoginName(name) && Object.keys(kept).length === LOGIN_FIELDS.central.length) named[name] = kept;
    }
  }
  return { logins, named };
}

/** Owner-only, through a temporary file that replaces it. A link, a hard-linked copy or someone else's file is refused. */
async function writeLogins(homeDir: string, logins: Logins, named: NamedLogins): Promise<void> {
  const file = loginFile(homeDir);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // Your own regular file with loose permissions is made private first, nothing for you to fix.
  const problem = await ownPrivateFile(file);
  if (problem) throw new Error(`Casper can't save network logins: ${problem}.`);
  if (!Object.keys(logins).length && !Object.keys(named).length) { await rm(file, { force: true }); return; }
  const content = Object.keys(named).length ? { ...logins, [NAMED_KEY]: named } : logins;
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(content, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/** A product's fields from `values`, checked: every field is needed and nothing else is taken. */
function checkedValues(product: NetworkProduct, values: Record<string, string>): Record<string, string> {
  const fields = LOGIN_FIELDS[product];
  const known = new Set(fields.map((field) => field.env));
  if (Object.keys(values).some((name) => !known.has(name))) throw new Error(`Not a ${PRODUCT_LABELS[product]} login field.`);
  for (const field of fields) {
    const problem = valueProblem(field.env, values[field.env]);
    if (problem) throw new Error(`${field.label} must be ${problem}.`);
  }
  return Object.fromEntries(fields.map((field) => [field.env, values[field.env]!]));
}

/** Saves (or replaces) one product's login. Every field of the product is needed; nothing else is taken. */
export async function saveLogin(homeDir: string, product: NetworkProduct, values: Record<string, string>): Promise<void> {
  if (!isNetworkProduct(product)) throw new Error("Unknown network product.");
  const checked = checkedValues(product, values);
  const { logins, named } = await readLoginFile(homeDir);
  logins[product] = checked;
  await writeLogins(homeDir, logins, named);
}

/** Saves (or replaces) a named Central login: the same fields as the main Central login. */
export async function saveNamedLogin(homeDir: string, name: string, values: Record<string, string>): Promise<void> {
  if (!isLoginName(name)) throw new Error("A login name is 1-32 lowercase letters and digits (not default or forget).");
  const checked = checkedValues("central", values);
  const { logins, named } = await readLoginFile(homeDir);
  named[name] = checked;
  await writeLogins(homeDir, logins, named);
}

export async function forgetLogin(homeDir: string, product: NetworkProduct): Promise<void> {
  const { logins, named } = await readLoginFile(homeDir);
  if (!logins[product]) {
    // Nothing usable saved for it; a file that holds only a broken entry is still cleaned.
    if (!(await lstat(loginFile(homeDir)).catch(() => undefined))) return;
  }
  delete logins[product];
  await writeLogins(homeDir, logins, named);
}

export async function forgetNamedLogin(homeDir: string, name: string): Promise<void> {
  const { logins, named } = await readLoginFile(homeDir);
  if (!named[name]) return;
  delete named[name];
  await writeLogins(homeDir, logins, named);
}

/** Env var → value for every saved product, and CENTRAL_<NAME>_… for each named Central login. */
export async function loginEnv(homeDir: string, warn?: (text: string) => void): Promise<Record<string, string>> {
  const { logins, named } = await readLoginFile(homeDir, warn);
  const env: Record<string, string> = Object.assign({}, ...Object.values(logins));
  for (const [name, values] of Object.entries(named)) {
    for (const [field, value] of Object.entries(values)) env[namedEnv(name, field)] = value;
  }
  return env;
}

/** The values to hide in a server's output: secrets and client IDs (named logins' too), 4 characters or longer. */
export function loginSecretValues(env: Record<string, string>): string[] {
  const hidden = (name: string) => HIDDEN_ENV.has(name) || (NAMED_ENV.test(name) && !name.endsWith("_BASE_URL"));
  return Object.entries(env).filter(([name, value]) => hidden(name) && value.length >= 4).map(([, value]) => value);
}

/**
 * Whether this definition gets the saved logins: it is Casper's network server by what it runs (never by its tool
 * list alone, which another program can copy) and it is your own, not a project's.
 */
export function getsLogins(definition: MCPServerDefinition): boolean {
  if (definition.transport.type !== "stdio" || definition.scope === "project") return false;
  return matchPreset(definition)?.preset.logins === true;
}

/** The env a server starts with: its own (with ${VAR}s filled in), plus the saved logins when it gets them. */
export async function spawnEnvFor(definition: MCPServerDefinition, homeDir: string, warn?: (text: string) => void): Promise<Record<string, string>> {
  if (definition.transport.type !== "stdio") return {};
  const own = Object.fromEntries(Object.entries(definition.transport.env).map(([name, value]) => [name, resolveEnvironment(value)]));
  return getsLogins(definition) ? { ...own, ...await loginEnv(homeDir, warn) } : own;
}
