/**
 * A network product's write in plain words, for its change box, its ◆ row and the receipt:
 * `mist_create_org_rf_template` → "Create RF template Standard-RF-80MHz (a copy of Standard-RF; 5 GHz width 40 → 80 MHz)",
 * `mist_update_site_info` → "site Lab-Site now uses RF template Standard-RF-80MHz (was Standard-RF)" and how to undo it.
 * Display only: read from the tool's name, its (already masked) arguments, the value before when Casper read it, and
 * objects this session's results named. Never a reason to run or refuse anything.
 */
import { isNetworkProduct, PRODUCT_LABELS } from "../mcp/network/logins";

export interface ChangeWords {
  /** The product the tool belongs to ("Mist"). */
  product: string;
  /** What the change box says first: "Create RF template …". */
  box: string;
  /** What changed, for the ◆ row and the receipt: "site Lab-Site now uses RF template … (was …)". */
  after: string;
  /** How to put it back, when Casper can tell: "set it back to Standard-RF". */
  undo?: string;
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** The JSON an MCP result carries: its structured content, else its text blocks parsed (several: a list). */
export function resultJson(raw: unknown): unknown {
  if (!isRecord(raw)) return undefined;
  if (raw.structuredContent !== undefined) return raw.structuredContent;
  if (!Array.isArray(raw.content)) return undefined;
  const values = raw.content.flatMap((block) => {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string" || block.text.length > 262_144) return [];
    try { return [JSON.parse(block.text) as unknown]; } catch { return []; }
  });
  return values.length === 1 ? values[0] : values.length ? values : undefined;
}

const MAX_OBJECTS = 300;
const MAX_KEPT_BYTES = 16_384;
const MAX_WALK = 2_000;

/** Objects with an id and a name that this session's results showed (a template, a site), newest last: ids are said
 * by name, and a new object that copies one of them says so. Bounded; secrets already hidden by the caller. */
export class RecentObjects {
  private readonly byId = new Map<string, { name: string; object?: Json }>();

  /** A result as the server sent it (MCP content or structured content). */
  remember(raw: unknown): void { this.rememberValue(resultJson(raw)); }

  rememberValue(value: unknown): void {
    const queue: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
    for (let seen = 0; queue.length && seen < MAX_WALK; seen++) {
      const { value: next, depth } = queue.shift()!;
      if (Array.isArray(next)) { if (depth < 6) queue.push(...next.map((item) => ({ value: item, depth: depth + 1 }))); continue; }
      if (!isRecord(next)) continue;
      const id = next.id, name = next.name;
      if ((typeof id === "string" || typeof id === "number") && typeof name === "string" && name.trim()) {
        const key = String(id);
        let size = Infinity;
        try { size = JSON.stringify(next).length; } catch { /* not kept whole */ }
        this.byId.delete(key);
        this.byId.set(key, { name: name.trim().slice(0, 80), ...(size <= MAX_KEPT_BYTES ? { object: next } : {}) });
        if (this.byId.size > MAX_OBJECTS) this.byId.delete(this.byId.keys().next().value!);
      }
      if (depth < 6) for (const item of Object.values(next)) if (typeof item === "object" && item !== null) queue.push({ value: item, depth: depth + 1 });
    }
  }

  name(id: unknown): string | undefined {
    return typeof id === "string" || typeof id === "number" ? this.byId.get(String(id))?.name : undefined;
  }

  /** The objects kept whole, newest first. */
  objects(): Array<{ name: string; object: Json }> {
    return [...this.byId.values()].reverse().flatMap((entry) => entry.object ? [{ name: entry.name, object: entry.object }] : []);
  }
}

const VERBS: Record<string, [string, string]> = {
  create: ["Create", "created"], add: ["Add", "added"], update: ["Update", "updated"], set: ["Set", "set"], delete: ["Delete", "deleted"],
  remove: ["Remove", "removed"], assign: ["Assign", "assigned"], unassign: ["Unassign", "unassigned"], enable: ["Turn on", "turned on"],
  disable: ["Turn off", "turned off"], reboot: ["Restart", "restarted"], restart: ["Restart", "restarted"], upgrade: ["Upgrade", "upgraded"],
  optimize: ["Optimize", "optimized"], bounce: ["Bounce", "bounced"], claim: ["Claim", "claimed"], release: ["Release", "released"],
  clone: ["Copy", "copied"], copy: ["Copy", "copied"], move: ["Move", "moved"], rename: ["Rename", "renamed"], replace: ["Replace", "replaced"],
  reset: ["Reset", "reset"], run: ["Run", "ran"], start: ["Start", "started"], stop: ["Stop", "stopped"],
};

const ABBREVIATIONS: Record<string, string> = {
  rf: "RF", rrm: "RRM", wlan: "WLAN", wlans: "WLANs", ssid: "SSID", ssids: "SSIDs", ap: "AP", aps: "APs", vlan: "VLAN", vlans: "VLANs",
  psk: "PSK", psks: "PSKs", nac: "NAC", sle: "SLE", vpn: "VPN", evpn: "EVPN", id: "ID", ids: "IDs", idp: "IDP", radius: "RADIUS",
  dhcp: "DHCP", dns: "DNS", ntp: "NTP", snmp: "SNMP", poe: "PoE", lldp: "LLDP", ospf: "OSPF", bgp: "BGP", acl: "ACL", nat: "NAT",
  wan: "WAN", lan: "LAN", ip: "IP", mac: "MAC", mxedge: "Mist Edge", mxtunnel: "Mist tunnel", gw: "gateway", setting: "settings",
};

/** Fields that point at another object by id, in plain words. */
const ID_FIELDS: Record<string, string> = {
  rftemplate_id: "RF template", networktemplate_id: "network template", gatewaytemplate_id: "gateway template",
  sitetemplate_id: "site template", aptemplate_id: "AP template", alarmtemplate_id: "alarm template", secpolicy_id: "security policy",
  sitegroup_ids: "site groups", deviceprofile_id: "device profile", map_id: "floor plan", template_id: "template",
};

/** Keys that say which object, or when, not what it is: left out of a copy's comparison and a change's fields. */
const IDENTITY = new Set(["id", "name", "org_id", "site_id", "created_time", "modified_time", "for_site", "msp_id"]);

const words = (key: string) => key.split(/[_\s]+/).filter(Boolean).map((word) => ABBREVIATIONS[word] ?? word).join(" ");

/** A long id said short: "00000000…". */
function shortId(value: unknown): string {
  const text = String(value);
  return text.length > 12 ? `${text.slice(0, 8)}…` : text;
}

const BANDS: Record<string, string> = { "24": "2.4 GHz", "5": "5 GHz", "6": "6 GHz" };

function list(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** "band_5.bandwidth" → "5 GHz width". */
function pathWords(path: string): string {
  return path.split(".").map((part) => {
    const band = /^band_(24|5|6)$/.exec(part)?.[1];
    if (band) return BANDS[band]!;
    if (part === "bandwidth") return "width";
    if (part === "power_min") return "min power";
    if (part === "power_max") return "max power";
    return words(part);
  }).join(" ");
}

function unit(path: string): string {
  const last = path.split(".").at(-1)!;
  return last === "bandwidth" ? " MHz" : /^power(?:_min|_max)?$/.test(last) ? " dBm" : "";
}

function valueText(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 80);
  if (value === null) return "none";
  try { return (JSON.stringify(value) ?? String(value)).slice(0, 80); } catch { return String(value); }
}

/** Each value under an object as "a.b.c" → value (lists and empty objects are values), identity keys left out at the top. */
function leaves(object: Json, prefix = "", depth = 0, into = new Map<string, unknown>()): Map<string, unknown> {
  for (const [key, value] of Object.entries(object)) {
    if (!prefix && IDENTITY.has(key)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (isRecord(value) && Object.keys(value).length && depth < 6) leaves(value, path, depth + 1, into);
    else into.set(path, value);
  }
  return into;
}

const same = (a: unknown, b: unknown) => { try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; } };

/** "a copy of Standard-RF; 5 GHz width 40 → 80 MHz" when the new object's values are, but for a few, one read this session. */
function copyOf(body: Json, recent: RecentObjects | undefined): string | undefined {
  const mine = leaves(body);
  if (mine.size < 4 || !recent) return undefined;
  let best: { name: string; diffs: string[] } | undefined;
  for (const { name, object } of recent.objects()) {
    if (name === body.name) continue;
    const theirs = leaves(object);
    const diffs: string[] = [];
    let alike = 0;
    for (const [path, value] of mine) {
      if (theirs.has(path) && same(theirs.get(path), value)) { alike++; continue; }
      diffs.push(theirs.has(path) ? `${pathWords(path)} ${valueText(theirs.get(path))} → ${valueText(value)}${unit(path)}` : `${pathWords(path)} ${valueText(value)}${unit(path)}`);
    }
    if (diffs.length > 3 || alike < mine.size * 0.75) continue;
    if (!best || diffs.length < best.diffs.length) best = { name, diffs };
  }
  return best && `a copy of ${best.name}${best.diffs.length ? `; ${best.diffs.join(", ")}` : ""}`;
}

/** The settings worth saying about a new object: its widths, SSID and VLAN, at most three. */
function keySettings(body: Json): string | undefined {
  const notable = [...leaves(body)].filter(([path]) => /(?:^|\.)(?:bandwidth|ssid|vlan_id)$/.test(path)).slice(0, 3);
  return notable.length ? notable.map(([path, value]) => `${pathWords(path)} ${valueText(value)}${unit(path)}`).join(", ") : undefined;
}

function idField(key: string): string | undefined {
  if (ID_FIELDS[key]) return ID_FIELDS[key];
  const base = /^(.+?)_ids?$/.exec(key)?.[1];
  if (!base || key === "org_id" || key === "site_id") return undefined;
  const kind = /^(.+?)(template|profile|policy|group)$/.exec(base);
  return kind ? `${words(kind[1]!)} ${kind[2]}` : words(base);
}

/**
 * A network product's write in plain words, or undefined for a tool that isn't one (`set_ssid`): the generic row stays.
 * `args` are what the box shows (secrets already hidden); `before` the changed fields' values read just before.
 */
export function describeNetworkChange(tool: string, args: Json, options: { before?: Json; recent?: RecentObjects } = {}): ChangeWords | undefined {
  const match = /^([a-z]+)_([a-z]+)(?:_(.+))?$/.exec(tool);
  if (!match || !isNetworkProduct(match[1])) return undefined;
  const product = PRODUCT_LABELS[match[1]];
  const verb = match[2]!;
  const { recent, before } = options;
  let parts = (match[3] ?? "").split("_").filter(Boolean);
  while (["org", "orgs", "msp"].includes(parts[0] ?? "")) parts = parts.slice(1);
  while (parts.length > 1 && ["info", "infos", "details"].includes(parts.at(-1)!)) parts = parts.slice(0, -1);
  const isSite = parts.length === 1 && parts[0] === "site";
  const siteScope = !isSite && parts[0] === "site" && parts.length > 1;
  if (siteScope && !["setting", "settings"].includes(parts[1]!)) parts = parts.slice(1);
  const object = parts.map((part) => ABBREVIATIONS[part] ?? part).join(" ");
  // What it sends: the body (or the object a tool names otherwise), else the arguments but the ids.
  const body = [args.body, args.changes, args.payload, args.data].find(isRecord)
    ?? Object.fromEntries(Object.entries(args).filter(([key]) => !/(?:^|_)ids?$/.test(key)));
  const name = (value: unknown) => recent?.name(value) ?? shortId(value);
  const siteId = args.site_id;
  const siteName = typeof siteId === "string" ? recent?.name(siteId) : undefined;
  const at = siteScope && typeof siteId === "string" ? ` at site ${siteName ?? shortId(siteId)}` : "";
  const [Verb, done] = VERBS[verb] ?? [verb.charAt(0).toUpperCase() + verb.slice(1), `ran ${verb}`];

  // Mist's radio channel plan, run now.
  if (verb === "optimize" && parts.at(-1) === "rrm") {
    const raw = Array.isArray(body.bands) ? body.bands : Array.isArray(args.bands) ? args.bands : [];
    const bands = list(raw.map((band) => BANDS[String(band)] ?? String(band)).map((band, index, all) => index < all.length - 1 ? band.replace(/ GHz$/, "") : band));
    return { product, box: `Run the radio channel plan (RRM)${bands ? ` on ${bands}` : ""}${at}`, after: `ran the ${bands ? `${bands} ` : ""}radio channel plan (RRM)${at}` };
  }

  // Which object: the site itself, the name the body gives it, or the id the arguments point at.
  const objectId = Object.entries(args).find(([key, value]) => key !== "org_id" && key !== "site_id" && /(?:^|_)(?:id|port|mac|serial)$/.test(key)
    && (typeof value === "string" || typeof value === "number"))?.[1];
  const target = isSite ? (typeof before?.name === "string" ? before.name : typeof body.name === "string" ? body.name : typeof siteId === "string" ? name(siteId) : undefined)
    : typeof body.name === "string" ? body.name : typeof args.name === "string" ? args.name : objectId !== undefined ? name(objectId) : undefined;
  const what = `${object}${target ? ` ${target}` : ""}${at}`;

  if (verb === "create" || verb === "add" || verb === "clone" || verb === "copy") {
    const detail = copyOf(body, recent) ?? keySettings(body);
    return { product, box: `${Verb} ${what}${detail ? ` (${detail})` : ""}`, after: `${done} ${what}${detail ? ` (${detail})` : ""}`,
      ...verb === "create" && target ? { undo: `delete ${object} ${target}` } : {} };
  }

  if (verb === "update" || verb === "set") {
    // What changes: every field but the one naming it (unless the value before says it was renamed), and none that
    // already had that value.
    const fields = Object.entries(body).filter(([key, value]) => {
      if (key === "name" && Object.keys(body).length > 1 && (!before || !("name" in before) || same(before.name, value))) return false;
      return !(before && key in before && same(before[key], value));
    });
    const known = (key: string) => before !== undefined && key in before;
    const ids = fields.filter(([key]) => idField(key) !== undefined && typeof body[key] !== "object");
    if (fields.length === 1 && ids.length === 1 && (isSite || target)) {
      const [key, value] = ids[0]!;
      const field = idField(key)!;
      const old = known(key) && before![key] !== null && before![key] !== "" ? name(before![key]) : undefined;
      const who = isSite ? `site ${target}` : what;
      return { product, box: `Set ${who}'s ${field} to ${name(value)}${old ? ` (now ${old})` : ""}`,
        after: `${who} now uses ${field} ${name(value)}${old ? ` (was ${old})` : ""}`, ...old ? { undo: `set it back to ${old}` } : {} };
    }
    const shown = fields.slice(0, 3);
    const more = fields.length > shown.length ? ` and ${fields.length - shown.length} more` : "";
    const text = (key: string, value: unknown) => idField(key) && typeof value !== "object" ? name(value) : valueText(value);
    const change = (was: string) => shown.map(([key, value]) => `${idField(key) ?? words(key)} ${text(key, value)}${known(key) ? ` (${was} ${text(key, before![key])})` : ""}`).join(", ");
    const lead = isSite ? `site ${target}` : what;
    const undo = shown.length && !more && shown.every(([key]) => known(key))
      ? shown.map(([key]) => `set ${idField(key) ?? words(key)} back to ${text(key, before![key])}`).join(" and ") : undefined;
    return { product, box: `${Verb} ${lead}${shown.length ? `: ${change("now")}${more}` : ""}`, after: `${done} ${lead}${shown.length ? `: ${change("was")}${more}` : ""}`,
      ...undo ? { undo } : {} };
  }

  return { product, box: `${Verb} ${what}`, after: `${done} ${what}` };
}
