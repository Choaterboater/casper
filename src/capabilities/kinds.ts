/**
 * Change kinds: what sort of change a tool makes, on top of its safety label. The label still decides
 * whether a call asks; the kind decides which changes are off by default (RISKY_KINDS) until the person
 * allows them. Vendor developer-site categories are a reference only; each tool is judged here, by the
 * server's `_meta["casper/change-kind"]` and Casper's own word lists.
 */
import type { MCPTool } from "../mcp/manager";
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

/** True when the call makes a risky or disruptive kind: it asks every time, with no "for this session" answer. */
export function asksEveryTime(plan: ApprovalPlan): boolean {
  return planKinds(plan).some((kind) => isRiskyKind(kind) || kind === "disruptive");
}

/** The kinds a planned call makes: each real tool behind a router, else the tool itself. */
export function planKinds(plan: ApprovalPlan, tool?: Pick<MCPTool, "_meta">): ChangeKind[] {
  // A router call is a change whatever its inner name reads as (invite_glp_user reads as a read): the words decide.
  if (plan.routed.length > 0) return plan.routed.map((call) => nameLabel(call.name) === "diagnostic" ? "troubleshoot" : wordKind(call.name));
  return [changeKind({ name: plan.tool, ...(tool?._meta ? { _meta: tool._meta } : {}) }, plan.label)];
}
