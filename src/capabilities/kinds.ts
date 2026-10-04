/**
 * Change kinds: what sort of change a tool makes, on top of its safety label. The label still decides
 * whether a call asks; the kind decides which changes are off by default (RISKY_KINDS) until the person
 * allows them. Vendor developer-site categories are a reference only; each tool is judged here, by the
 * server's `_meta["casper/change-kind"]` and Casper's own word lists.
 */
import type { MCPTool } from "../mcp/manager";
import { isRecord } from "../mcp/config";
import { isNetworkProduct, type NetworkProduct } from "../mcp/network/logins";
import type { ApprovalPlan } from "./approval";
import { nameLabel, toolWords, type CapabilitySafety } from "./labels";

export type ChangeKind = "read" | "troubleshoot" | "config" | "disruptive" | "firmware" | "delete" | "admin";
export const CHANGE_KINDS: readonly ChangeKind[] = ["read", "troubleshoot", "config", "disruptive", "firmware", "delete", "admin"];
/** Off by default on every server until the person allows them. Disruptive changes are not here: their
 * label is destructive, so each one asks every time. */
export const RISKY_KINDS: readonly ChangeKind[] = Object.freeze(["firmware", "delete", "admin"] as ChangeKind[]);

export function isChangeKind(value: unknown): value is ChangeKind {
  return typeof value === "string" && (CHANGE_KINDS as readonly string[]).includes(value);
}
export function isRiskyKind(kind: ChangeKind): boolean { return RISKY_KINDS.includes(kind); }
/** Plain words for each kind, as the boxes and /mcp show them ("Firmware changes are off by default on Mist."). */
export const KIND_TEXT: Readonly<Record<ChangeKind, string>> = Object.freeze({
  read: "Reads", troubleshoot: "Troubleshooting checks", config: "Configuration changes", disruptive: "Disruptive actions",
  firmware: "Firmware changes", delete: "Deletes", admin: "Admin and account changes",
});

const DELETE_WORDS = new Set(["delete", "remove", "unclaim", "erase", "zeroize", "destroy", "wipe", "purge", "factory"]);
const FIRMWARE_WORDS = new Set(["firmware", "upgrade", "downgrade", "image", "ota"]);
/** Account and access words. "role" alone is a network policy role on Aruba, so only a role assignment counts. */
const ADMIN_WORDS = new Set(["admin", "administrator", "sso", "saml", "invite", "token", "tokens", "apitoken", "rbac",
  "privilege", "privileges", "scim", "password", "credential", "credentials"]);
/** Weaker account words, checked after the disruptive ones so disconnect_user stays disruptive. */
const ACCOUNT_WORDS = new Set(["user", "users", "account", "accounts"]);
const DISRUPTIVE_WORDS = new Set(["bounce", "reboot", "restart", "reload", "disconnect", "deauth", "deauthenticate",
  "halt", "shutdown", "powercycle", "power", "reset", "kick"]);
const TROUBLESHOOT_WORDS = new Set(["ping", "traceroute", "show", "test", "iperf", "speedtest", "cable", "nslookup", "blink"]);

/** The kind Casper's word lists give a tool name. Never `read`: that comes from the label. */
function wordKind(name: string): ChangeKind {
  const words = toolWords(name);
  const has = (list: Set<string>) => words.some((word) => list.has(word));
  if (has(DELETE_WORDS)) return "delete";
  if (has(FIRMWARE_WORDS)) return "firmware";
  if (has(ADMIN_WORDS) || (words.includes("role") && words.some((word) => word.startsWith("assignment")))) return "admin";
  if (has(DISRUPTIVE_WORDS)) return "disruptive";
  if (has(ACCOUNT_WORDS)) return "admin";
  if (has(TROUBLESHOOT_WORDS)) return "troubleshoot";
  return "config";
}

/**
 * A tool's change kind. `read` and `diagnostic` labels are `read` and `troubleshoot`. Otherwise the
 * server's `_meta["casper/change-kind"]` is used when it is a known kind other than `read`, except that it
 * can never make a name Casper reads as risky into a kind that isn't.
 */
export function changeKind(tool: Pick<MCPTool, "name" | "_meta">, label: CapabilitySafety): ChangeKind {
  if (label === "read") return "read";
  if (label === "diagnostic") return "troubleshoot";
  const words = wordKind(tool.name);
  const declared = tool._meta?.["casper/change-kind"];
  if (!isChangeKind(declared) || declared === "read") return words;
  if (isRiskyKind(words) && !isRiskyKind(declared)) return words;
  return declared;
}

/** The riskier of two kinds, in CHANGE_KINDS order (read < troubleshoot < config < disruptive < firmware < delete < admin). */
export function riskier(a: ChangeKind, b: ChangeKind): ChangeKind {
  return CHANGE_KINDS.indexOf(b) > CHANGE_KINDS.indexOf(a) ? b : a;
}

/** True when the call makes a risky or disruptive kind: it asks every time, with no "for this session" answer.
 * Pass the tool so a direct call's server tag counts, and the server's find_tool kinds for a routed call. */
export function asksEveryTime(plan: ApprovalPlan, tool?: Pick<MCPTool, "_meta">, hitKinds?: ReadonlyMap<string, ChangeKind>): boolean {
  return planKinds(plan, tool, hitKinds).some((kind) => isRiskyKind(kind) || kind === "disruptive");
}

/**
 * The kinds a planned call makes: each real tool behind a router, else the tool itself. A routed tool's kind is the
 * riskier of its name words and the kind the server's find_tool gave it (`hitKinds`, or the kind the broker put on
 * the routed call): a server can raise a tool's risk, never lower it, and a declared `read` never counts, because a
 * routed call that reaches the box is a change.
 */
export function planKinds(plan: ApprovalPlan, tool?: Pick<MCPTool, "_meta">, hitKinds?: ReadonlyMap<string, ChangeKind>): ChangeKind[] {
  // A router call is a change whatever its inner name reads as (invite_glp_user reads as a read): the words decide.
  // A name Casper reads as a read that find_tool calls a troubleshooting check (get_lldp_neighbors) is one: that raises it
  // from a read, so it doesn't count as a config change. A name that reads as a change or as running commands keeps its words.
  if (plan.routed.length > 0) return plan.routed.map((call) => {
    const hit = hitKinds?.get(call.name) ?? call.kind;
    const label = nameLabel(call.name);
    const own = label === "diagnostic" || (label === "read" && hit === "troubleshoot") ? "troubleshoot" : wordKind(call.name);
    return isChangeKind(hit) && hit !== "read" ? riskier(own, hit) : own;
  });
  return [changeKind({ name: plan.tool, ...(tool?._meta ? { _meta: tool._meta } : {}) }, plan.label)];
}

/** What a router's find_tool said about one inner tool: its kind and, when it names one Casper knows, its product. */
export interface RouterHit { kind: ChangeKind; product?: NetworkProduct }
/** At most this many find_tool names are kept per server. */
export const MAX_HITS_PER_SERVER = 500;

/**
 * The kinds in a find_tool result: `[{name, kind, product, …}]`, as the server's SDK sends a list (one text block per
 * hit, or structuredContent `{result: [...]}`), or `{hits: [...]}`. A kind that isn't one of Casper's is left out;
 * so is a product Casper doesn't know.
 */
export function hitKindsFrom(raw: unknown): Map<string, RouterHit> {
  const items: unknown[] = [];
  const take = (value: unknown) => {
    if (Array.isArray(value)) items.push(...value);
    else if (isRecord(value) && Array.isArray(value.result)) items.push(...value.result);
    else if (isRecord(value) && Array.isArray(value.hits)) items.push(...value.hits);
    else if (isRecord(value)) items.push(value);
  };
  if (isRecord(raw) && raw.structuredContent !== undefined) take(raw.structuredContent);
  else if (isRecord(raw) && Array.isArray(raw.content)) for (const block of raw.content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
    try { take(JSON.parse(block.text)); } catch { /* not a hit */ }
  }
  const hits = new Map<string, RouterHit>();
  for (const item of items) {
    if (!isRecord(item) || typeof item.name !== "string" || !item.name || item.name.length > 200 || !isChangeKind(item.kind)) continue;
    const prev = hits.get(item.name);
    const kind = prev ? riskier(prev.kind, item.kind) : item.kind;
    hits.set(item.name, { kind, ...(isNetworkProduct(item.product) ? { product: item.product } : prev?.product ? { product: prev.product } : {}) });
    if (hits.size >= MAX_HITS_PER_SERVER) break;
  }
  return hits;
}

/** The plan with each routed call carrying the kind the server's find_tool gave it, so the box and planLabel see it. */
export function withHitKinds(plan: ApprovalPlan, hitKinds: ReadonlyMap<string, ChangeKind>): ApprovalPlan {
  if (!plan.routed.some((call) => hitKinds.has(call.name))) return plan;
  return { ...plan, routed: plan.routed.map((call) => {
    const kind = hitKinds.get(call.name);
    return kind && isChangeKind(kind) ? { ...call, kind } : call;
  }) };
}
