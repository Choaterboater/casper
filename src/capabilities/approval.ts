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
 * Secret text inside config strings goes through the shared secret rules (src/secrets/scrub.ts
 * scrubText) by default; `MaskOptions.scrubText` can replace them.
 */
import { APPROVE_CHOICES, APPROVE_ONCE_CHOICES, APPROVE_ONCE_PREVIEW_CHOICES, APPROVE_PREVIEW_CHOICES, approveAllLabel, junosShowLabel, kindAllowChoices } from "../app/safe-choices";
import type { MCPTool } from "../mcp/manager";
import { isSecretKey as isScrubbedKey, scrubText } from "../secrets/scrub";
import { redactPreview, terminalText } from "../tui/format";
import { asksEveryTime, KIND_TEXT, type ChangeKind } from "./kinds";
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

export interface RoutedCall {
  name: string; arguments: Record<string, unknown>;
  /** The kind the server's find_tool gave this tool (set by the broker). It can only make the call stricter. */
  kind?: ChangeKind;
}

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
  /** Hides secrets inside free text. Defaults to redactPreview plus the shared secret rules. */
  scrubText?: TextScrubber;
}
export interface FormatOptions extends MaskOptions { now?: number }

export const PREVIEW_KEYS = ["dry_run", "dryRun", "preview", "check_only", "validate_only"] as const;
export const CONFIRM_KEYS = ["confirm", "confirmed", "force"] as const;
/** Any spelling of a key a server may read as confirm or as a preview switch: case, "-" and "_"
 * don't matter (Confirm, CONFIRMED, dry-run, DryRun), and "confirmation" counts as confirm. */
const CONFIRM_WORDS = new Set(["confirm", "confirmed", "confirmation", "force"]);
const PREVIEW_WORDS = new Set(["dryrun", "preview", "checkonly", "validateonly"]);
function keyWord(key: string): string { return key.toLowerCase().replace(/[^a-z0-9]/g, ""); }
function isConfirmKey(key: string): boolean { return CONFIRM_WORDS.has(keyWord(key)); }
function isPreviewKey(key: string): boolean { return PREVIEW_WORDS.has(keyWord(key)); }
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

/** The least label a server-given kind implies: a troubleshooting check asks (diagnostic), a change is a write. */
function kindLabel(kind: ChangeKind | undefined): CapabilitySafety[] {
  if (kind === undefined || kind === "read" || !(KIND_TEXT as Record<string, string>)[kind]) return [];
  return [kind === "troubleshoot" ? "diagnostic" : "write"];
}

/** The label the call is judged by: the tool's own, the real tools' names, and "not read" for an unclear router. */
export function planLabel(plan: ApprovalPlan): CapabilitySafety {
  return strictest(plan.label, ...plan.routed.map((call) => nameLabel(call.name)), ...plan.routed.flatMap((call) => kindLabel(call.kind)),
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

/**
 * A confirm value that a server may read as yes. Many servers turn "true", "yes", "on" or 1 into
 * true (Python's pydantic does), so those count as the AI saying yes too.
 */
function saysYes(value: unknown): boolean {
  if (value === true || value === 1) return true;
  return typeof value === "string" && ["true", "1", "yes", "y", "on"].includes(value.trim().toLowerCase());
}

/** A preview switch that is set, but not to a plain true or false: servers read "false" or 0 differently. */
function unclearSwitch(value: unknown): boolean {
  return value !== undefined && value !== null && typeof value !== "boolean";
}

/** Paths where confirm, confirmed or force says yes, anywhere in the arguments (router inner arguments too). */
export function aiConfirm(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  walk(args, (key, value, path) => { if (isConfirmKey(key) && saysYes(value)) paths.push(path); });
  return paths;
}

/** Paths where a preview switch is false, or set to something that is not plain true/false, anywhere in the arguments. */
export function previewSwitchedOff(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  walk(args, (key, value, path) => {
    if (isPreviewKey(key) && (value === false || unclearSwitch(value))) paths.push(path);
  });
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

interface ModeDetail { mode: CallMode; key: string; why: "set" | "default" | "hint" | "none" | "unclear" }

function hintSaysPreview(hint: ApprovalHint | undefined, args: Record<string, unknown>): boolean {
  const when = hint?.previewWhen;
  return !!when && Object.keys(when).length > 0 && Object.entries(when).every(([key, value]) => args[key] === value);
}

function directMode(schema: MCPTool["inputSchema"] | undefined, args: Record<string, unknown>, hint?: ApprovalHint): ModeDetail {
  const unclear = PREVIEW_KEYS.find((key) => unclearSwitch(args[key]));
  if (unclear) return { mode: "may-execute", key: unclear, why: "unclear" };
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
  const unclear = PREVIEW_KEYS.find((key) => unclearSwitch(call.arguments[key]));
  if (unclear) return { mode: "may-execute", key: unclear, why: "unclear" };
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

/**
 * The same call with the preview switch on and confirm/confirmed/force turned off. Every other
 * preview switch the call already sets is turned on too, so no switch still says "make the change".
 */
export function previewArguments(plan: ApprovalPlan): Record<string, unknown> {
  const key = previewSwitch(plan);
  if (!key) throw new Error("This call has no safe preview");
  const args = structuredClone(plan.arguments);
  args[key] = true;
  for (const other of Object.keys(args)) if (isPreviewKey(other) && args[other] !== undefined) args[other] = true;
  confirmOff(args, 0);
  return args;
}

/** Turns every confirm/confirmed/force that says yes into false, at any depth. */
function confirmOff(value: unknown, depth: number): void {
  if (depth > MAX_DEPTH) return;
  if (Array.isArray(value)) { for (const item of value) confirmOff(item, depth + 1); return; }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (isConfirmKey(key) && saysYes(item)) value[key] = false;
    else confirmOff(item, depth + 1);
  }
}

function canonical(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return null;
  if (Array.isArray(value)) return value.map((item) => canonical(item, depth + 1));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (isPreviewKey(key) || isConfirmKey(key)) continue;
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
  // Never looser than what is hidden from the AI (src/secrets/scrub.ts).
  return !NOT_SECRET_KEYS.has(snake) && (SECRET_KEY.test(snake) || isScrubbedKey(key));
}

const MASKED = /^••• \d+ chars?$/;

export function maskedLength(text: string): string {
  const count = [...text].length;
  return `••• ${count} char${count === 1 ? "" : "s"}`;
}

/** The shared secret rules (src/secrets/scrub.ts). Token shapes are redacted first, so the scrubber's
 * "<secret hidden>" marker is never itself rewritten by the redaction. */
export const defaultScrubText: TextScrubber = (text) => maskSecretPairs(scrubText(redactPreview(text)).text);

const QUOTED_PAIR = /"([^"\\\n]{1,64})"(\s*:\s*)"((?:[^"\\\n]|\\.)*)("|$)/g;
const PLAIN_PAIR = /(^|[\s,;{(&?])([A-Za-z][A-Za-z0-9_.-]{0,63})([ \t]*[=:][ \t]*)([^\s,;"'&}<•][^\s,;"'&}]*)/gm;

/**
 * Secrets written as pairs inside free text: "wpa_passphrase":"..." in JSON that did not parse (a
 * cut or wrapped result), and psk=... or password: ... in plain text. Values already hidden are kept.
 */
export function maskSecretPairs(text: string): string {
  return text
    .replace(QUOTED_PAIR, (match, key: string, gap: string, value: string, end: string) =>
      isSecretKey(key) && value !== "" && !MASKED.test(value) && !value.startsWith("<") ? `"${key}"${gap}"${maskedLength(value)}${end}` : match)
    .replace(PLAIN_PAIR, (match, before: string, key: string, gap: string, value: string) =>
      isSecretKey(key) ? `${before}${key}${gap}${maskedLength(value)}` : match);
}

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
      if (secret && item !== "") {
        hidden.add(key ?? "value");
        // Already hidden (a stored preview): keep the count of the real value.
        return MASKED.test(item) ? item : maskedLength(item);
      }
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
  if (detail.mode === "execute") return "This makes the change.";
  if (detail.mode === "may-execute") {
    return `May make the change (${detail.key} ${detail.why === "unclear" ? "is not a plain true or false" : "is not set"}).`;
  }
  if (detail.why === "hint") return "Preview only: nothing changes.";
  if (detail.why === "default") return `Preview only: nothing changes (${detail.key} is on by default).`;
  return `Preview only: nothing changes (${detail.key}=true).`;
}

/** "set_ssid" -> "set ssid", "rebootDevice" -> "reboot device". */
export function toolWords(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[_\-\s.]+/).filter(Boolean).join(" ").toLowerCase();
}

/** One "  key   value" line per argument, secrets already masked. */
function valueLines(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value === undefined ? [] : [`  ${JSON.stringify(value)}`];
  return Object.entries(value as Record<string, unknown>).map(([key, item]) =>
    `  ${key.padEnd(16)} ${typeof item === "string" ? item : JSON.stringify(item)}`);
}

function list(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** Raw arguments over 4 KB are never shown in part, so they are never run. */
export function tooLongToShow(args: Record<string, unknown>): boolean {
  return Buffer.byteLength(JSON.stringify(args)) > MAX_SHOWN_ARGUMENT_BYTES;
}

/** Whether "Yes, for this session" may be offered and may cover later calls: never for a tool that runs commands
 * (exec) or is destructive, because one answer would then let any later command or destructive call run unasked. */
export function sessionAllowed(label: CapabilitySafety): boolean { return label !== "exec" && label !== "destructive"; }

/** The change box's question, under what changes. */
export const APPROVAL_QUESTION = "Make this change?";

/** What one digit in the change box means. */
export type ApprovalChoice = "no" | "preview" | "yes" | "yes-session" | "allow-all" | "show-session";

/**
 * The change box: what changes in plain words, one value per line (secrets hidden), whether it makes the change,
 * then numbered choices. 1 is always No; "Preview first" only when the tool's own preview can run; a destructive
 * change gets no "for this session" answer. The technical line (server, tool, label) closes the box.
 */
export function formatApproval(plan: ApprovalPlan, lastPreview?: LastPreview,
  options: FormatOptions & { product?: string; toolProduct?: string; scope?: string; tool?: Pick<MCPTool, "_meta">; showOnly?: boolean } = {}):
{ preview: string; question: string; labels: string[]; choices: string[]; answers: Record<string, ApprovalChoice> } {
  const single = plan.routed.length === 1 && !plan.routerUnclear ? plan.routed[0]! : undefined;
  // The product the one real tool belongs to, when the server said ("Mist"); "Yes to everything" still names the
  // whole server, because that is what it covers.
  const lines = [`Change in ${options.toolProduct ?? options.product ?? plan.server}: ${toolWords(single?.name ?? plan.tool)}`];
  // Where the login can change things (access-check v2); the server enforces it.
  if (options.scope) lines.push(`Your login can change: ${options.scope}`);
  if (plan.routerUnclear && !plan.routed.length) lines.push(`Runs: a tool Casper can't see (through ${plan.tool})`);
  else if (single) lines.push(`Runs: ${single.name} (through ${plan.tool})`);
  else if (plan.routed.length) {
    const unseen = plan.routerUnclear ? ", and tools Casper can't see" : "";
    lines.push(`Runs ${plan.routed.length} tools (through ${plan.tool}): ${plan.routed.map((call) => call.name).join(", ")}${unseen}`);
  }
  // A single routed call shows its own arguments; anything else shows what was sent.
  const masked = maskSecrets(single ? single.arguments : plan.arguments, options);
  lines.push(...valueLines(masked.value));
  if (masked.hidden.length) {
    lines.push(`Hidden: ${masked.hidden.join(", ")}. The server still gets the real value${masked.hidden.length > 1 ? "s" : ""}.`);
  }
  lines.push(modeLine(modeDetail(plan)));
  if (plan.hint?.executeNote) lines.push(`Note: ${plan.hint.executeNote}`);
  const confirms = [...new Set(aiConfirm(plan.arguments).map((path) => path.split(".").at(-1)!))];
  if (confirms.length) {
    lines.push(`⚠ The AI set ${list(confirms.map((key) => `${key}=true`))}. That skips the server's own check. Only your answer here lets it run.`);
  }
  const offer = canPreview(plan);
  if (lastPreview) {
    const text = maskText(lastPreview.text, options);
    const cut = text.length > LAST_PREVIEW_CHARS ? `${text.slice(0, LAST_PREVIEW_CHARS)} … (more not shown)` : text;
    lines.push(`Last preview (${ago(lastPreview.at, options.now ?? Date.now())}): ${cut}`);
  } else if (offer) lines.push("No preview yet.");
  lines.push(`MCP · ${plan.server} · ${plan.tool}  [${planLabel(plan)}]`);
  const onceOnly = !sessionAllowed(planLabel(plan)) || asksEveryTime(plan, options.tool);
  const all = approveAllLabel(options.product ?? plan.server);
  // A plain Junos show (no session answer, it runs commands): 3 opts this server's show commands in for the session.
  const show = options.showOnly && onceOnly ? junosShowLabel(plan.server) : undefined;
  const base: readonly string[] = onceOnly ? (offer ? APPROVE_ONCE_PREVIEW_CHOICES : APPROVE_ONCE_CHOICES) : offer ? APPROVE_PREVIEW_CHOICES : APPROVE_CHOICES;
  const labels: readonly string[] = [...base.slice(0, 2), ...(show ? [show] : []), ...base.slice(2), all];
  const meaning: Record<string, ApprovalChoice> = {
    "No": "no", "Preview first": "preview", "Yes, this once": "yes", "Yes, for this session": "yes-session", [all]: "allow-all",
    ...(show ? { [show]: "show-session" as const } : {}),
  };
  const choices = labels.map((_, index) => String(index + 1));
  const answers = Object.fromEntries(labels.map((label, index) => [String(index + 1), meaning[label]!]));
  return {
    // Every line is one line: a tool name, key or value can't add a fake choice or question line.
    preview: `${lines.map((line) => terminalText(line.replace(LINE_BREAKS, " "))).join("\n")}\n`,
    question: APPROVAL_QUESTION,
    labels: [...labels],
    choices,
    answers,
  };
}

/** The box before the change box when a call makes a risky kind the user hasn't allowed on this server. */
export function kindBox(kind: ChangeKind, product: string, realTool: string): { preview: string; question: string; labels: string[] } {
  return {
    preview: `${KIND_TEXT[kind]} are off by default on ${terminalText(product)}.\n  Runs: ${toolWords(realTool)}\n`,
    question: `Allow ${KIND_TEXT[kind].toLowerCase()} on ${terminalText(product)}?`,
    labels: kindAllowChoices(kind),
  };
}
