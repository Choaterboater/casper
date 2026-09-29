/**
 * The approval box for MCP calls. Pure functions: no I/O.
 *
 * What this module promises:
 * - It names the real tool behind a router call, and judges the call by that tool's name.
 * - It never makes a call look safer than it is: a preview switch left out on a router is "may
 *   EXECUTE", and "p to preview first" is offered only when the tool's own schema has the switch.
 * - The AI can not approve for the user: confirm/confirmed/force set to true, or a preview switch set
 *   to false, always needs the user's yes, whatever the label.
 * - Secrets are hidden on screen only. The server still gets the real value, and the model already
 *   had it.
 *
 * Secret text inside config strings goes through a replaceable scrubber (`MaskOptions.scrubText`).
 * The built-in one is a stopgap with a few Junos and Aruba rules; the shared secret rules
 * (src/secrets/scrub.ts scrubText) plug in there, and then `interimConfigScrub` should be deleted.
 */
import type { MCPTool } from "../mcp/manager";
import { redactPreview, terminalText } from "../tui/format";
import { nameLabel, strictest, type CapabilitySafety } from "./labels";

export type CallMode = "execute" | "preview" | "may-execute";

/** Per-tool advice from a preset. It can only add caution or words; it never removes an approval. */
export interface ApprovalHint {
  /** When every listed argument has this value, nothing changes (Junos render_and_apply_j2_template apply_config=false). */
  previewWhen?: Record<string, unknown>;
  /** One plain line shown under the mode (Junos load_and_commit_config: "Commits at once. No auto-rollback."). */
  executeNote?: string;
  /** The tool has no safe preview, so "p" is never offered. */
  noPreview?: boolean;
}

export interface RoutedCall { name: string; arguments: Record<string, unknown> }

export interface ApprovalPlan {
  server: string;
  /** The MCP tool Casper calls (a router such as invoke_tool, or the tool itself). */
  tool: string;
  /** The tool's own label (toolLabel). */
  label: CapabilitySafety;
  schema: MCPTool["inputSchema"];
  arguments: Record<string, unknown>;
  /** The real tools behind a router call; empty for a direct call. */
  routed: RoutedCall[];
  /** The tool looks like a router, but Casper could not tell which tool it runs. */
  routerUnclear: boolean;
  hint?: ApprovalHint;
}

export interface LastPreview { text: string; at: number }

export type TextScrubber = (text: string) => string;
export interface MaskOptions {
  /** Hides secrets inside free text. Defaults to the stopgap Junos/Aruba rules plus redactPreview. */
  scrubText?: TextScrubber;
}
export interface FormatOptions extends MaskOptions { now?: number }

export const PREVIEW_KEYS = ["dry_run", "dryRun", "preview", "check_only", "validate_only"] as const;
export const CONFIRM_KEYS = ["confirm", "confirmed", "force"] as const;
/** Raw arguments longer than this are not shown, so they are not run. */
export const MAX_SHOWN_ARGUMENT_BYTES = 4096;
export const TOO_LONG_TEXT = "Too long to show in full (over 4 KB); not run.";
const LAST_PREVIEW_CHARS = 1536;
const MAX_DEPTH = 32;
const LINE_BREAKS = /[\r\n\v\f\u0085\u2028\u2029]+/g;

const ROUTER_NAME = /invoke|dispatch|call_tool|run_tool/i;
const INNER_NAME_KEYS = ["name", "tool", "tool_name"] as const;
const INNER_ARGS_KEYS = ["arguments", "args", "params"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function innerCall(value: unknown): RoutedCall | undefined {
  if (!isRecord(value)) return undefined;
  const nameKey = INNER_NAME_KEYS.find((key) => typeof value[key] === "string" && value[key] !== "");
  if (!nameKey) return undefined;
  const argsKey = INNER_ARGS_KEYS.find((key) => isRecord(value[key]));
  return { name: value[nameKey] as string, arguments: argsKey ? value[argsKey] as Record<string, unknown> : {} };
}

/** The real tools a router-shaped call runs: {name, arguments} or calls[] of the same. */
export function routedCalls(tool: string, args: Record<string, unknown>): RoutedCall[] {
  if (!ROUTER_NAME.test(tool)) return [];
  const calls: RoutedCall[] = [];
  const single = innerCall(args);
  if (single) calls.push(single);
  if (Array.isArray(args.calls)) for (const entry of args.calls) {
    const call = innerCall(entry);
    if (call) calls.push(call);
  }
  return calls;
}

export function isRouterName(tool: string): boolean { return ROUTER_NAME.test(tool); }

export function buildPlan(input: {
  server: string; tool: string; label: CapabilitySafety; schema: MCPTool["inputSchema"];
  arguments: Record<string, unknown>; hint?: ApprovalHint;
}): ApprovalPlan {
  const routed = routedCalls(input.tool, input.arguments);
  const batch = Array.isArray(input.arguments.calls) ? input.arguments.calls.length : 0;
  const routerUnclear = isRouterName(input.tool)
    && (routed.length === 0 || (batch > 0 && routed.length !== batch + (innerCall(input.arguments) ? 1 : 0)));
  return { ...input, routed, routerUnclear };
}

/** The label the call is judged by: the tool's own, the real tools' names, and "not read" for an unclear router. */
export function planLabel(plan: ApprovalPlan): CapabilitySafety {
  return strictest(plan.label, ...plan.routed.map((call) => nameLabel(call.name)),
    ...(plan.routerUnclear ? ["external-action" as const] : []));
}

function walk(value: unknown, visit: (key: string, value: unknown, path: string) => void, path = "", depth = 0): void {
  if (depth > MAX_DEPTH) return;
  if (Array.isArray(value)) value.forEach((item, index) => walk(item, visit, `${path}[${index}]`, depth + 1));
  else if (isRecord(value)) for (const [key, item] of Object.entries(value)) {
    const itemPath = path ? `${path}.${key}` : key;
    visit(key, item, itemPath);
    walk(item, visit, itemPath, depth + 1);
  }
}

/** Paths where confirm, confirmed or force is true, anywhere in the arguments (router inner arguments too). */
export function aiConfirm(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  walk(args, (key, value, path) => { if ((CONFIRM_KEYS as readonly string[]).includes(key) && value === true) paths.push(path); });
  return paths;
}

/** Paths where a preview switch is explicitly false, anywhere in the arguments. */
export function previewSwitchedOff(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  walk(args, (key, value, path) => { if ((PREVIEW_KEYS as readonly string[]).includes(key) && value === false) paths.push(path); });
  return paths;
}

/**
 * True when the user must say yes: the call is not read, or the AI tried to skip a check itself
 * (confirm/confirmed/force true, or a preview switch set to false). A read label never overrides that.
 */
export function needsApproval(plan: ApprovalPlan): boolean {
  return planLabel(plan) !== "read" || aiConfirm(plan.arguments).length > 0 || previewSwitchedOff(plan.arguments).length > 0;
}

function properties(schema: MCPTool["inputSchema"] | undefined): Record<string, unknown> {
  return isRecord(schema?.properties) ? schema.properties : {};
}

function allowsBoolean(property: unknown): boolean {
  if (!isRecord(property)) return false;
  const type = property.type;
  if (type === "boolean" || (Array.isArray(type) && type.includes("boolean"))) return true;
  const options = Array.isArray(property.anyOf) ? property.anyOf : Array.isArray(property.oneOf) ? property.oneOf : [];
  return options.some(allowsBoolean);
}

interface ModeDetail { mode: CallMode; key: string; why: "set" | "default" | "hint" | "none" }

function hintSaysPreview(hint: ApprovalHint | undefined, args: Record<string, unknown>): boolean {
  const when = hint?.previewWhen;
  return !!when && Object.keys(when).length > 0 && Object.entries(when).every(([key, value]) => args[key] === value);
}

function directMode(schema: MCPTool["inputSchema"] | undefined, args: Record<string, unknown>, hint?: ApprovalHint): ModeDetail {
  const set = PREVIEW_KEYS.filter((key) => typeof args[key] === "boolean");
  const off = set.find((key) => args[key] === false);
  if (off) return { mode: "execute", key: off, why: "set" };
  if (set.length) return { mode: "preview", key: set[0]!, why: "set" };
  if (hintSaysPreview(hint, args)) return { mode: "preview", key: "", why: "hint" };
  const props = properties(schema);
  const declared = PREVIEW_KEYS.filter((key) => isRecord(props[key]));
  const byDefault = declared.find((key) => (props[key] as Record<string, unknown>).default === true);
  // A default of false, or no default, executes: the switch has to be asked for.
  if (byDefault && declared.every((key) => (props[key] as Record<string, unknown>).default !== false)) {
    return { mode: "preview", key: byDefault, why: "default" };
  }
  return { mode: "execute", key: declared[0] ?? "dry_run", why: declared.length ? "default" : "none" };
}

function routedMode(call: RoutedCall): ModeDetail {
  const set = PREVIEW_KEYS.filter((key) => typeof call.arguments[key] === "boolean");
  const off = set.find((key) => call.arguments[key] === false);
  if (off) return { mode: "execute", key: off, why: "set" };
  if (set.length) return { mode: "preview", key: set[0]!, why: "set" };
  // Casper cannot see the real tool's schema, so it cannot know its default.
  return { mode: "may-execute", key: "dry_run", why: "none" };
}

const MODE_ORDER: Record<CallMode, number> = { preview: 0, "may-execute": 1, execute: 2 };

function modeDetail(plan: ApprovalPlan): ModeDetail {
  if (plan.routerUnclear) return { mode: "may-execute", key: "dry_run", why: "none" };
  if (!plan.routed.length) return directMode(plan.schema, plan.arguments, plan.hint);
  return plan.routed.map(routedMode).reduce((worst, next) => MODE_ORDER[next.mode] > MODE_ORDER[worst.mode] ? next : worst);
}

/** Whether the call changes something: preview (nothing changes), execute, or may-execute (can't tell). */
export function callMode(schema: MCPTool["inputSchema"] | undefined, args: Record<string, unknown>, hint?: ApprovalHint): CallMode {
  return directMode(schema, args, hint).mode;
}

export function planMode(plan: ApprovalPlan): CallMode { return modeDetail(plan).mode; }

/** The preview switch the tool's own schema declares, if Casper may use it. */
function previewSwitch(plan: ApprovalPlan): string | undefined {
  if (plan.hint?.noPreview || plan.routed.length || plan.routerUnclear || isRouterName(plan.tool)) return undefined;
  const props = properties(plan.schema);
  return PREVIEW_KEYS.find((key) => allowsBoolean(props[key]));
}

/**
 * "p to preview first" is safe only when the tool itself declares the switch. A router's real tool
 * has a schema Casper cannot see; a server that ignores an unknown dry_run would make the change.
 */
export function canPreview(plan: ApprovalPlan): boolean {
  return previewSwitch(plan) !== undefined && planMode(plan) !== "preview";
}

/** The same call with the preview switch on and confirm/confirmed/force turned off. */
export function previewArguments(plan: ApprovalPlan): Record<string, unknown> {
  const key = previewSwitch(plan);
  if (!key) throw new Error("This call has no safe preview");
  const args = structuredClone(plan.arguments);
  args[key] = true;
  for (const confirm of CONFIRM_KEYS) if (args[confirm] === true) args[confirm] = false;
  return args;
}

function canonical(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return null;
  if (Array.isArray(value)) return value.map((item) => canonical(item, depth + 1));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if ((PREVIEW_KEYS as readonly string[]).includes(key) || (CONFIRM_KEYS as readonly string[]).includes(key)) continue;
    out[key] = canonical(value[key], depth + 1);
  }
  return out;
}

/** Same server, same real tool, same arguments apart from the preview switch and confirm. */
export function previewKey(plan: ApprovalPlan): string {
  const target = plan.routed.length
    ? plan.routed.map((call) => ({ tool: call.name, arguments: canonical(call.arguments) }))
    : [{ tool: plan.tool, arguments: canonical(plan.arguments) }];
  return JSON.stringify([plan.server, plan.tool, target]);
}

// ---- Secrets ----------------------------------------------------------------------------------

const NOT_SECRET_KEYS = new Set(["key", "cursor", "next_cursor", "list_key", "public_key", "token_type", "sort_key"]);
const SECRET_KEY = /(^|_)(pass|password|passwd|passphrase|passcode|psk|preshared|secret|token|credential|credentials|community|authorization)($|_)|(^|_)(api|private|shared|pre_shared|wpa|auth|radius|access|secret|priv|encryption)_?key($|_)|^snmp_(read|write)$/;

function snakeKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();
}

/** A key whose value is a secret: password, passphrase, psk, secret, token, api key, community, and similar. */
export function isSecretKey(key: string): boolean {
  const snake = snakeKey(key);
  return !NOT_SECRET_KEYS.has(snake) && SECRET_KEY.test(snake);
}

export function maskedLength(text: string): string {
  const count = [...text].length;
  return `••• ${count} char${count === 1 ? "" : "s"}`;
}

const HIDDEN = "•••";
/** Stopgap config rules, replaced by the shared secret rules. Junos: encrypted-password "...",
 * authentication-key, secret, pre-shared-key ascii-text. Aruba: wpa-passphrase, password
 * [plaintext|ciphertext] ..., key 7 ..., snmp community. */
const CONFIG_SECRET = /\b(ascii-text|hexadecimal|encrypted-password|authentication-key|simple-password|wpa-passphrase|passphrase|password|secret|community)((?:\s+(?:plaintext|ciphertext|cipher|encrypted|clear|[05789]))?\s+)("[^"\n]*"|'[^'\n]*'|[^\s;{}"',]+)/gi;
const CONFIG_KEY = /\b(key)(\s+(?:plaintext|ciphertext|[05789])\s+)("[^"\n]*"|'[^'\n]*'|[^\s;{}"',]+)/gi;
function hideConfigValue(_match: string, word: string, gap: string, value: string): string {
  const quote = value.startsWith("\"") || value.startsWith("'") ? value[0] : "";
  return `${word}${gap}${quote}${HIDDEN}${quote}`;
}
export function interimConfigScrub(text: string): string {
  return text.replace(CONFIG_SECRET, hideConfigValue).replace(CONFIG_KEY, hideConfigValue);
}
export const defaultScrubText: TextScrubber = (text) => redactPreview(interimConfigScrub(text));

/**
 * A copy of `value` with secrets hidden for the screen. Strings under a secret-looking key become
 * "••• N chars"; other strings go through the text scrubber. `hidden` names what was hidden.
 */
export function maskSecrets(value: unknown, options: MaskOptions = {}): { value: unknown; hidden: string[] } {
  const scrub = options.scrubText ?? defaultScrubText;
  const hidden = new Set<string>();
  const mask = (item: unknown, key: string | undefined, secret: boolean, depth: number): unknown => {
    if (depth > MAX_DEPTH) return "[too deep]";
    if (typeof item === "string") {
      if (secret && item !== "") { hidden.add(key ?? "value"); return maskedLength(item); }
      const scrubbed = scrub(item);
      if (scrubbed !== item && scrubbed !== terminalText(item)) hidden.add(`parts of ${key ?? "value"}`);
      return scrubbed;
    }
    if (Array.isArray(item)) return item.map((entry) => mask(entry, key, secret, depth + 1));
    if (isRecord(item)) {
      const out: Record<string, unknown> = {};
      for (const [name, entry] of Object.entries(item)) out[name] = mask(entry, name, secret || isSecretKey(name), depth + 1);
      return out;
    }
    return item;
  };
  return { value: mask(value, undefined, false, 0), hidden: [...hidden] };
}

/** Server text (a preview result, a server question) made safe to show: secrets hidden, controls escaped. */
export function maskText(text: string, options: MaskOptions = {}): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { return terminalText(JSON.stringify(maskSecrets(JSON.parse(trimmed), options).value)); } catch { /* plain text */ }
  }
  return terminalText((options.scrubText ?? defaultScrubText)(text));
}

// ---- The box ---------------------------------------------------------------------------------

function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

function modeLine(detail: ModeDetail): string {
  if (detail.mode === "execute") return "Mode: EXECUTE (this makes the change)";
  if (detail.mode === "may-execute") return `Mode: may EXECUTE (${detail.key} is not set)`;
  if (detail.why === "hint") return "Mode: preview (nothing changes)";
  if (detail.why === "default") return `Mode: preview (${detail.key} is on by default, nothing changes)`;
  return `Mode: preview (${detail.key}=true, nothing changes)`;
}

function list(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** Raw arguments over 4 KB are never shown in part, so they are never run. */
export function tooLongToShow(args: Record<string, unknown>): boolean {
  return Buffer.byteLength(JSON.stringify(args)) > MAX_SHOWN_ARGUMENT_BYTES;
}

/** The approval box text, the question and the answers it accepts. */
export function formatApproval(plan: ApprovalPlan, lastPreview?: LastPreview, options: FormatOptions = {}):
{ preview: string; question: string; choices: string[] } {
  const lines = [`MCP · ${plan.server} · ${plan.tool}  [${planLabel(plan)}]`];
  if (plan.routerUnclear && !plan.routed.length) lines.push(`Runs: a tool Casper can't see (through ${plan.tool})`);
  else if (plan.routed.length === 1 && !plan.routerUnclear) lines.push(`Runs: ${plan.routed[0]!.name} (through ${plan.tool})`);
  else if (plan.routed.length) {
    const unseen = plan.routerUnclear ? ", and tools Casper can't see" : "";
    lines.push(`Runs ${plan.routed.length} tools (through ${plan.tool}): ${plan.routed.map((call) => call.name).join(", ")}${unseen}`);
  }
  lines.push(modeLine(modeDetail(plan)));
  if (plan.hint?.executeNote) lines.push(`Note: ${plan.hint.executeNote}`);
  const masked = maskSecrets(plan.arguments, options);
  lines.push(`Arguments: ${JSON.stringify(masked.value)}`);
  if (masked.hidden.length) {
    lines.push(`Hidden: ${masked.hidden.join(", ")}. The server still gets the real value${masked.hidden.length > 1 ? "s" : ""}.`);
  }
  const confirms = [...new Set(aiConfirm(plan.arguments).map((path) => path.split(".").at(-1)!))];
  if (confirms.length) {
    lines.push(`⚠ The AI set ${list(confirms.map((key) => `${key}=true`))}. That skips the server's own check. Only your yes here lets it run.`);
  }
  const offer = canPreview(plan);
  if (lastPreview) {
    const text = maskText(lastPreview.text, options);
    const cut = text.length > LAST_PREVIEW_CHARS ? `${text.slice(0, LAST_PREVIEW_CHARS)} … (more not shown)` : text;
    lines.push(`Last preview (${ago(lastPreview.at, options.now ?? Date.now())}): ${cut}`);
  } else if (offer) lines.push("No preview yet.");
  return {
    // Every line is one line: a tool name, key or preview can't add a fake "Mode:" or "Run it?" line.
    preview: `${lines.map((line) => terminalText(line.replace(LINE_BREAKS, " "))).join("\n")}\n`,
    question: offer ? "Run it? Type yes, or p to preview first: " : "Run it? Type yes: ",
    choices: offer ? ["yes", "p"] : ["yes"],
  };
}
