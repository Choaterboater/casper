import type { CapabilitySafety } from "../capabilities/broker";
import type { MCPTool } from "./manager";

/**
 * The `casper/access-check v1` contract. A server may offer a read-only tool named `access_check`
 * that asks each product it talks to what the current login may do:
 *
 *   {"contract": "casper/access-check v1",
 *    "products": [{"product": "central", "access": "read-only" | "read-write" | "unknown",
 *                  "identity"?: string, "role"?: string,
 *                  "server_gate"?: {"env_var": string, "state": string}}]}
 *
 * Only this answer can make Casper call a login read-only, and only when every product says so.
 * Anything else, including no answer, a malformed answer or an error, is "unknown". The result
 * only ever restricts: "read-write" unlocks nothing. Server text never reaches the model; only the
 * parsed state does, and identity/role are kept only when they are short and plain.
 */
export const ACCESS_CONTRACT = "casper/access-check v1";
/** v2 adds, per product, where the login can change things ("can_change") and where it can only read ("read_only"):
 * lists of {"kind": "org" | "site" | "sitegroup", "id", "name"}. The server enforces them; Casper shows them. */
export const ACCESS_CONTRACT_V2 = "casper/access-check v2";
const SCOPE_KINDS = new Set(["org", "site", "sitegroup"]);
const MAX_SCOPES = 64;
export const ACCESS_TOOL = "access_check";
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_PRODUCTS = 32;

export type AccessState = "read-only" | "read-write" | "unknown";
export interface AccessProduct {
  product: string;
  access: AccessState;
  identity?: string;
  role?: string;
  /** The server's own write gate for this product, when it reports one. */
  gate?: { envVar: string; off: boolean };
  /** v2: where this login can change things, and where it can only read (plain names only). */
  canChange?: AccessScope[];
  readOnly?: AccessScope[];
}
export interface AccessScope { kind: "org" | "site" | "sitegroup"; id: string; name: string }
export interface AccessCheck { state: AccessState; products: AccessProduct[] }

const UNKNOWN: AccessCheck = Object.freeze({ state: "unknown", products: [] }) as AccessCheck;
const PRODUCT = /^[a-z0-9][a-z0-9_.-]{0,31}$/i;
const PLAIN = /^[A-Za-z0-9 _.@:/+-]{1,64}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const GATE_OFF = new Set(["disabled", "off"]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function plain(value: unknown): string | undefined {
  return typeof value === "string" && PLAIN.test(value) ? value : undefined;
}

/** The JSON body of a tool result: structuredContent first, else the only text block. */
function body(result: unknown): unknown {
  if (!record(result) || result.isError === true) return undefined;
  if (record(result.structuredContent)) return result.structuredContent;
  const content = Array.isArray(result.content) ? result.content : [];
  const texts = content.filter((item): item is { type: "text"; text: string } => record(item) && item.type === "text" && typeof item.text === "string");
  if (texts.length !== 1) return undefined;
  const text = texts[0]!.text;
  if (Buffer.byteLength(text) > MAX_RESULT_BYTES) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

/** A v2 scope list: plain entries of a known kind kept, anything else dropped; too long a list is dropped whole. */
function scopes(value: unknown): AccessScope[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > MAX_SCOPES) return undefined;
  const kept = value.flatMap((item): AccessScope[] => {
    if (!record(item) || typeof item.kind !== "string" || !SCOPE_KINDS.has(item.kind)) return [];
    const id = plain(item.id), name = plain(item.name);
    return id && name ? [{ kind: item.kind as AccessScope["kind"], id, name }] : [];
  });
  return kept.length ? kept : undefined;
}

/** Where the login can change things, in plain words ("Lab site", "2 sites and 1 org"); undefined when not reported. */
export function changeScopeText(check: AccessCheck | undefined): string | undefined {
  const all = check?.products.flatMap((product) => product.canChange ?? []) ?? [];
  if (!all.length) return undefined;
  if (all.length === 1) return `${all[0]!.name} ${all[0]!.kind === "sitegroup" ? "site group" : all[0]!.kind}`;
  const counts = new Map<string, number>();
  for (const scope of all) counts.set(scope.kind, (counts.get(scope.kind) ?? 0) + 1);
  const words = [...counts].map(([kind, count]) => {
    const noun = kind === "sitegroup" ? "site group" : kind;
    return `${count} ${noun}${count === 1 ? "" : "s"}`;
  });
  return words.length === 1 ? words[0]! : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** Parse an access_check tool result. Never throws; anything unexpected is "unknown". */
export function parseAccessCheck(result: unknown): AccessCheck {
  const document = body(result);
  if (!record(document) || (document.contract !== ACCESS_CONTRACT && document.contract !== ACCESS_CONTRACT_V2) || !Array.isArray(document.products)) return UNKNOWN;
  const v2 = document.contract === ACCESS_CONTRACT_V2;
  if (!document.products.length || document.products.length > MAX_PRODUCTS) return UNKNOWN;
  const products: AccessProduct[] = [];
  const seen = new Set<string>();
  for (const item of document.products) {
    if (!record(item) || typeof item.product !== "string" || !PRODUCT.test(item.product)) return UNKNOWN;
    const name = item.product.toLowerCase();
    if (seen.has(name)) return UNKNOWN;
    seen.add(name);
    const access: AccessState = item.access === "read-only" || item.access === "read-write" ? item.access : "unknown";
    const product: AccessProduct = { product: name, access };
    const identity = plain(item.identity);
    const role = plain(item.role);
    if (identity) product.identity = identity;
    if (role) product.role = role;
    const gate = item.server_gate;
    if (record(gate) && typeof gate.env_var === "string" && ENV_NAME.test(gate.env_var) && typeof gate.state === "string") {
      product.gate = { envVar: gate.env_var, off: GATE_OFF.has(gate.state.toLowerCase()) };
    }
    if (v2) {
      const canChange = scopes(item.can_change);
      const readOnly = scopes(item.read_only);
      if (canChange) product.canChange = canChange;
      if (readOnly) product.readOnly = readOnly;
    }
    products.push(product);
  }
  const state: AccessState = products.every((product) => product.access === "read-only")
    ? "read-only"
    : products.some((product) => product.access === "read-write") ? "read-write" : "unknown";
  return { state, products };
}

/**
 * The tool Casper may call on its own once per connection: named access_check, marked read-only
 * and not destructive by the server, labelled "read" by Casper, and needing no arguments.
 */
export function accessCheckTool(tools: readonly MCPTool[], labelOf: (tool: MCPTool) => CapabilitySafety): MCPTool | undefined {
  const tool = tools.find((candidate) => candidate.name === ACCESS_TOOL);
  if (!tool || tool.annotations?.readOnlyHint !== true || tool.annotations?.destructiveHint === true) return undefined;
  if (labelOf(tool) !== "read") return undefined;
  const required = tool.inputSchema.required;
  if (Array.isArray(required) && required.length) return undefined;
  return tool;
}

/** Whether the server itself reports every product's write gate as off: the pins took hold. */
export function gatesConfirmedOff(check: AccessCheck | undefined): boolean {
  return !!check && check.products.length > 0 && check.products.every((product) => product.gate?.off === true);
}

/** The login part of a /mcp line. */
export function accessStatusText(check: AccessCheck | undefined): string {
  if (!check || check.state === "unknown") return "access not checked";
  if (check.state === "read-only") return "login: read-only (checked)";
  const where = changeScopeText(check);
  return where ? `login: can change ${where} (checked)` : "login: can make changes (checked)";
}

/** Lines for the find_capability description. Built only from the server name and parsed state. */
export function accessModelLines(server: string, check: AccessCheck | undefined, writes: "off" | "on"): string[] {
  if (check?.state === "read-only") return [`${server}: login is read-only. Write tools are hidden. Don't plan changes on it.`];
  return writes === "off" ? [`${server}: every change asks the user first, in Casper's box; they can allow it once or for this session. Don't ask them again in chat.`] : [];
}

/** Reasons inside "Not executed (...)" refusals. */
export function readOnlyLoginReason(server: string): string { return `${server} login is read-only.`; }
export function writesOffReason(server: string): string {
  return `${server} writes are off. Only the user can allow a change there: in Casper's change box, or with /mcp writes ${server}.`;
}
export const READ_ONLY_LOGIN_ENABLE_TEXT = "This login is read-only (access_check). Writes can't be turned on here.";
