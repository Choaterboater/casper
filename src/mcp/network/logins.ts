import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { privateFileProblem } from "../../platform/private-file";
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
}

/** The Mist clouds, in the order of the `servers` list of the Mist spec the server bundles. */
const MIST_CLOUDS: [string, string][] = [
  ["Global 01", "api.mist.com"], ["Global 02", "api.gc1.mist.com"], ["Global 03", "api.ac2.mist.com"], ["Global 04", "api.gc2.mist.com"],
  ["Global 05", "api.gc4.mist.com"], ["EMEA 01", "api.eu.mist.com"], ["EMEA 02", "api.gc3.mist.com"], ["EMEA 03", "api.ac6.mist.com"],
  ["EMEA 04", "api.gc6.mist.com"], ["APAC 01", "api.ac5.mist.com"], ["APAC 02", "api.gc5.mist.com"], ["APAC 03", "api.gc7.mist.com"],
];
/** The Central regions from the `servers` list of the Central specs the server bundles (its internal one left out). */
const CENTRAL_REGIONS: [string, string][] = [
  ["US 1", "us1"], ["US 2", "us2"], ["US 4", "us4"], ["US 5", "us5"], ["US 6", "us6"], ["Canada 1", "ca1"], ["EU 1", "de1"], ["EU 2", "de2"],
  ["EU 3", "de3"], ["UK 1", "gb1"], ["India 1", "in1"], ["Japan 1", "jp1"], ["Australia 1", "au1"], ["UAE 1", "ae1"],
];

export const LOGIN_FIELDS: Record<NetworkProduct, LoginField[]> = {
  mist: [
    { key: "host", env: "MIST_HOST", label: "Mist cloud", secret: false,
      choices: MIST_CLOUDS.map(([name, host]) => ({ label: `${name} (${host})`, value: `https://${host}` })) },
    { key: "token", env: "MIST_API_TOKEN", label: "Mist API token", secret: true },
  ],
  central: [
    { key: "base_url", env: "CENTRAL_BASE_URL", label: "Central region", secret: false,
      choices: [
        ...CENTRAL_REGIONS.map(([name, code]) => ({ label: `${name} (${code}.api.central.arubanetworks.com)`, value: `https://${code}.api.central.arubanetworks.com` })),
        { label: "China 1 (cn1.api.central.arubanetworks.com.cn)", value: "https://cn1.api.central.arubanetworks.com.cn" },
      ] },
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
const VALUE = /^[\x21-\x7e]{1,4096}$/;
const MAX_FILE_BYTES = 64 * 1024;

export type Logins = Partial<Record<NetworkProduct, Record<string, string>>>;

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
  const file = loginFile(homeDir);
  const leaf = await lstat(file).catch(() => undefined);
  if (!leaf) return {};
  const problem = await privateFileProblem(file).catch(() => "it can't be checked");
  if (problem) {
    const why = /accessible to other users/.test(problem) ? "it can be read by other users" : problem.replace(/;.*$/, "");
    sayOnce(warn, `Casper's network login file isn't used: ${why}. Type /mcp login <product> to save the login again, privately.`);
    return {};
  }
  let parsed: unknown;
  try {
    if (leaf.size > MAX_FILE_BYTES) throw new Error("too large");
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    sayOnce(warn, "Casper's network login file can't be read. Type /mcp login <product> to save the login again.");
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const logins: Logins = {};
  for (const product of NETWORK_PRODUCTS) {
    const values = clean(product, (parsed as Record<string, unknown>)[product]);
    if (Object.keys(values).length) logins[product] = values;
  }
  return logins;
}

/** Owner-only, through a temporary file that replaces it. A link, a hard-linked copy or someone else's file is refused. */
async function writeLogins(homeDir: string, logins: Logins): Promise<void> {
  const file = loginFile(homeDir);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  let problem = await privateFileProblem(file);
  if (problem && /accessible to other users/.test(problem)) {
    // Your own regular file with loose permissions: replaced by a private one, nothing for you to fix.
    await chmod(file, 0o600);
    problem = await privateFileProblem(file);
  }
  if (problem) throw new Error(`Casper can't save network logins: ${problem}.`);
  if (!Object.keys(logins).length) { await rm(file, { force: true }); return; }
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(logins, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/** Saves (or replaces) one product's login. Every field of the product is needed; nothing else is taken. */
export async function saveLogin(homeDir: string, product: NetworkProduct, values: Record<string, string>): Promise<void> {
  if (!isNetworkProduct(product)) throw new Error("Unknown network product.");
  const fields = LOGIN_FIELDS[product];
  const known = new Set(fields.map((field) => field.env));
  if (Object.keys(values).some((name) => !known.has(name))) throw new Error(`Not a ${PRODUCT_LABELS[product]} login field.`);
  for (const field of fields) {
    const problem = valueProblem(field.env, values[field.env]);
    if (problem) throw new Error(`${field.label} must be ${problem}.`);
  }
  const logins = await readLogins(homeDir);
  logins[product] = Object.fromEntries(fields.map((field) => [field.env, values[field.env]!]));
  await writeLogins(homeDir, logins);
}

export async function forgetLogin(homeDir: string, product: NetworkProduct): Promise<void> {
  const logins = await readLogins(homeDir);
  if (!logins[product]) {
    // Nothing usable saved for it; a file that holds only a broken entry is still cleaned.
    if (!(await lstat(loginFile(homeDir)).catch(() => undefined))) return;
  }
  delete logins[product];
  await writeLogins(homeDir, logins);
}

/** Env var → value for every saved product. */
export async function loginEnv(homeDir: string, warn?: (text: string) => void): Promise<Record<string, string>> {
  return Object.assign({}, ...Object.values(await readLogins(homeDir, warn)));
}

/** The values to hide in a server's output: secrets and the client ID, 4 characters or longer. */
export function loginSecretValues(env: Record<string, string>): string[] {
  return Object.entries(env).filter(([name, value]) => HIDDEN_ENV.has(name) && value.length >= 4).map(([, value]) => value);
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
