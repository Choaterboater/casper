import { ADD_LOGIN_CHOICES, forgetLoginChoices, numberedLines } from "../../app/safe-choices";
import type { AccessCheck, AccessProduct } from "../access";
import { forgetLogin, isNetworkProduct, LOGIN_FIELDS, NETWORK_PRODUCTS, PRODUCT_LABELS, readLogins, saveLogin, type LoginField, type NetworkProduct } from "./logins";

/**
 * Asking for a product's login the first time it is used (or with /mcp login <product>). Only the person
 * answers: the question is on the exact-answer channel and the values go through the private prompt, so the
 * AI's ask tool has no way in and a key typed before a prompt appeared never fills it. The AI only ever
 * learns that a login was added and what it can change, never a value.
 */

export interface LoginHost {
  homeDir: string;
  /** False in a one-shot run. */
  interactive: boolean;
  /** False when nobody can be asked privately here (a one-shot run, piped input, Casper closing). */
  canAsk(): boolean;
  /** One exact typed answer from the person (never the AI), or undefined when nobody answered. */
  chooseAnswer(preview: string, question: string, choices: readonly string[]): Promise<string | undefined>;
  /** Hidden typed input from the person; undefined when cancelled. */
  privateInput(label: string): Promise<string | undefined>;
  write(text: string): void;
  /** Restarts the server once its running calls finish, so it starts with the new login. */
  restart(server: string): Promise<void>;
  /** The server's access_check answer on its current connection. */
  access(server: string): AccessCheck | undefined;
  /** Products the person said Not now to in this session: not asked again until /mcp login. */
  notNow?: Set<NetworkProduct>;
  /** Runs the questions in the same one-at-a-time queue as approval boxes (the restart after them runs outside it). */
  exclusive?<T>(work: () => Promise<T>): Promise<T>;
}

export type LoginResult = "added" | "not-now" | "cant-ask" | "failed";

/** What casper-network-mcp says when a product has no login: exactly {"error":"login_missing","product":<a product it knows>}. */
export function loginMissing(result: unknown): NetworkProduct | undefined {
  const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  if (!record(result)) return undefined;
  let body: unknown = result.structuredContent;
  if (body === undefined) {
    const content = Array.isArray(result.content) ? result.content : [];
    const texts = content.filter((item): item is { type: "text"; text: string } => record(item) && item.type === "text" && typeof item.text === "string");
    if (texts.length !== 1 || texts[0]!.text.length > 1024) return undefined;
    try { body = JSON.parse(texts[0]!.text); } catch { return undefined; }
  }
  // FastMCP wraps a plain return value as {"result": …}.
  if (record(body) && Object.keys(body).length === 1 && record(body.result)) body = body.result;
  if (!record(body) || body.error !== "login_missing" || Object.keys(body).some((key) => key !== "error" && key !== "product")) return undefined;
  return isNetworkProduct(body.product) ? body.product : undefined;
}

const ASKS: Record<NetworkProduct, string> = {
  mist: "Casper will ask for a Mist API token. Use one that can reach only the sites you want, not an admin token.",
  central: "Casper will ask for a Central API client ID and secret. Use a client with only the access you need, not an admin one.",
  clearpass: "Casper will ask for a ClearPass API token. Use one with only the access you need, not an admin one.",
};

/** The line for the person when nobody can be asked here. */
function cantAskLine(host: LoginHost, product: NetworkProduct): string {
  const label = PRODUCT_LABELS[product];
  return host.interactive
    ? `Adding a ${label} login needs Casper's full terminal, where it stays hidden. Type /mcp login ${product} there.`
    : `${label} has no login yet. Run casper and type /mcp login ${product}.`;
}

/** Names when there are a few ("Branch-12", "Branch-12 and Lab"), else counts ("5 sites and 1 org"). */
function scopeNames(product: AccessProduct): string | undefined {
  const scopes = product.canChange ?? [];
  if (!scopes.length) return undefined;
  const names = scopes.map((scope) => scope.name);
  if (names.length <= 3) return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  const counts = new Map<string, number>();
  for (const scope of scopes) counts.set(scope.kind, (counts.get(scope.kind) ?? 0) + 1);
  const words = [...counts].map(([kind, count]) => `${count} ${kind === "sitegroup" ? "site group" : kind}${count === 1 ? "" : "s"}`);
  return words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** What the login can do, from access_check: "read-only", "can change Branch-12", or undefined when not known. */
export function loginReach(check: AccessCheck | undefined, product: NetworkProduct): string | undefined {
  const entry = check?.products.find((item) => item.product === product);
  if (!entry || entry.loginMissing) return undefined;
  if (entry.access === "read-only") return "read-only";
  if (entry.access !== "read-write") return undefined;
  const where = scopeNames(entry);
  return where ? `can change ${where}` : "can make changes";
}

async function askField(host: LoginHost, field: LoginField): Promise<string | undefined> {
  if (field.choices) {
    const digits = field.choices.map((_choice, index) => String(index + 1));
    const answer = await host.chooseAnswer(`${field.label}:\n${numberedLines(field.choices.map((choice) => choice.label))}`, `Type 1-${digits.length}: `, digits);
    return answer && digits.includes(answer) ? field.choices[Number(answer) - 1]!.value : undefined;
  }
  let value: string | undefined;
  try { value = (await host.privateInput(field.label))?.trim(); } catch { return undefined; }
  if (!value) return undefined;
  // An address typed without its scheme is taken as https; a trailing slash is dropped.
  if (/BASE_URL$/.test(field.env)) value = (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`).replace(/\/+$/, "");
  return value;
}

/** The question, each field, then the save. Not now when the person says so or leaves a field empty. */
async function askAndSave(host: LoginHost, product: NetworkProduct): Promise<LoginResult> {
  const label = PRODUCT_LABELS[product];
  const saved = !!(await readLogins(host.homeDir))[product];
  const intro = saved ? `Replace the ${label} login? ${ASKS[product]}` : `${label} isn't set up yet. ${ASKS[product]}`;
  const answer = await host.chooseAnswer(`${intro}\n${numberedLines(ADD_LOGIN_CHOICES)}`, "Type 1 or 2: ", ["1", "2"]);
  const notNow = () => {
    if (answer !== undefined) host.notNow?.add(product);
    host.write(`Not added. Type /mcp login ${product} any time.\n`);
    return "not-now" as const;
  };
  if (answer !== "2") {
    if (answer === undefined) return "not-now";
    return notNow();
  }
  const values: Record<string, string> = {};
  for (const field of LOGIN_FIELDS[product]) {
    const value = await askField(host, field);
    if (value === undefined) return notNow();
    values[field.env] = value;
  }
  try { await saveLogin(host.homeDir, product, values); }
  catch (error) {
    host.write(`${error instanceof Error ? error.message : String(error)} Nothing saved.\n`);
    return "failed";
  }
  return "added";
}

async function addLogin(host: LoginHost, server: string | undefined, product: NetworkProduct, explicit: boolean): Promise<{ result: LoginResult; reach?: string }> {
  const label = PRODUCT_LABELS[product];
  if (!host.canAsk()) { host.write(`${cantAskLine(host, product)}\n`); return { result: "cant-ask" }; }
  // Said Not now this session: the AI's next try doesn't ask again; /mcp login does.
  if (!explicit && host.notNow?.has(product)) return { result: "not-now" };
  const asked = await (host.exclusive ? host.exclusive(() => askAndSave(host, product)) : askAndSave(host, product));
  if (asked !== "added") return { result: asked };
  host.notNow?.delete(product);
  if (!server) {
    host.write(`${label} login saved. The network server isn't set up yet: type /mcp setup network.\n`);
    return { result: "added" };
  }
  // Starts again with the new login once its running calls finish, then checks what the login can do.
  await host.restart(server);
  const reach = loginReach(host.access(server), product);
  host.write(`${label} login: ${reach ? `${reach} (checked)` : "saved (not checked)"}\n`);
  return { result: "added", ...(reach ? { reach } : {}) };
}

/** The first-use ask (and /mcp login <product>): 1 Not now · 2 Add a login, then each field, saved, restarted, checked. */
export async function askForLogin(host: LoginHost, server: string | undefined, product: NetworkProduct, options: { explicit?: boolean } = {}): Promise<LoginResult> {
  return (await addLogin(host, server, product, options.explicit === true)).result;
}

/** What the AI's call gets back when the product had no login: whether one was added, never a value. */
export async function loginMissingAnswer(host: LoginHost, server: string, product: NetworkProduct): Promise<string> {
  const label = PRODUCT_LABELS[product];
  const { result, reach } = await addLogin(host, server, product, false);
  if (result === "added") return `${label} login added${reach ? ` (${reach})` : ""}. Call the tool again.`;
  if (result === "cant-ask") {
    return host.interactive
      ? `${label} has no login yet. The person can add one: type /mcp login ${product} in Casper's full terminal.`
      : `${label} has no login yet. The person can add one: run casper and type /mcp login ${product}.`;
  }
  return `${label} has no login yet, and the person didn't add one now. Don't ask them in chat; they can type /mcp login ${product}.`;
}

/** /mcp login: each product and its state. */
export async function loginLines(host: Pick<LoginHost, "homeDir" | "access">, server: string | undefined): Promise<string[]> {
  const logins = await readLogins(host.homeDir);
  const check = server ? host.access(server) : undefined;
  return NETWORK_PRODUCTS.map((product) => {
    if (!logins[product]) return `${PRODUCT_LABELS[product]}: not set up — /mcp login ${product}`;
    const reach = loginReach(check, product);
    return `${PRODUCT_LABELS[product]}: ${reach ? `${reach} (checked)` : "set up"}`;
  });
}

/** /mcp login <product> forget: 1 Keep it · 2 Forget the <product> login, then the server restarts without it. */
export async function askToForgetLogin(host: LoginHost, server: string | undefined, product: NetworkProduct): Promise<"forgot" | "kept" | "none" | "cant-ask"> {
  const label = PRODUCT_LABELS[product];
  if (!(await readLogins(host.homeDir))[product]) { host.write(`${label} has no saved login.\n`); return "none"; }
  if (!host.interactive) { host.write(`Type /mcp login ${product} forget in the terminal.\n`); return "cant-ask"; }
  const choices = forgetLoginChoices(label);
  const answer = await host.chooseAnswer(`Forget the ${label} login?\n${numberedLines(choices)}`, "Type 1 or 2: ", ["1", "2"]);
  if (answer !== "2") { if (answer !== undefined) host.write(`Kept the ${label} login.\n`); return "kept"; }
  await forgetLogin(host.homeDir, product);
  if (server) await host.restart(server);
  host.write(`Forgot the ${label} login.\n`);
  return "forgot";
}
