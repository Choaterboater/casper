/**
 * Named network checks: the shape of `verify.checks.<name>` entries that use a
 * ready-made preset, the user's lab list, and the result every network check
 * returns. Casper builds each preset's argument list itself and never runs it
 * through a shell.
 *
 * The lab list comes only from the owner's own settings (~/.casper/config.yaml
 * or a profile). A project file cannot set it, because anyone can write one.
 */

import { isIP } from "node:net";

export type NetworkCheckKind = "offline" | "lab" | "report";
export type NetworkPreset =
  | "ansible-syntax" | "ansible-render" | "junoser" | "hier-config" | "yanglint" | "junos-commit" | "ansible-check";

export const NETWORK_PRESETS: readonly NetworkPreset[] = [
  "ansible-syntax", "ansible-render", "junoser", "hier-config", "yanglint", "junos-commit", "ansible-check",
];
/** Presets that reach devices. They only run when the user starts them on a declared lab. */
export const LAB_PRESETS: readonly NetworkPreset[] = ["junos-commit", "ansible-check"];
/** Presets whose result is a report (a diff), never a pass or a fail. */
export const REPORT_PRESETS: readonly NetworkPreset[] = ["hier-config"];

export type HierConfigPlatform = "aoscx" | "junos";

export interface NetworkCheckSpec {
  kind: NetworkCheckKind;
  /** A free-form shell command (offline only), run the same way as today's verify.test. */
  run?: string;
  preset?: NetworkPreset;
  playbooks?: string[];
  files?: string[];
  inventory?: string;
  platform?: HierConfigPlatform;
  running?: string;
  intended?: string;
  /** yanglint: folders searched for YANG modules, and the modules to load. */
  models?: string[];
  modules?: string[];
  /** Offline checks run after each change unless set to "ask". Lab and report checks never run on their own. */
  after?: "each-change" | "ask";
  /** Seconds; default 120 for offline and report checks, 600 for lab checks. */
  timeout?: number;
}

/** Owner-declared lab devices: exact hostnames, single IPs and IP ranges (CIDR). */
export interface LabSettings { hosts: string[] }

/** One network check outcome. The same fields as a VerificationResult, plus kind, label, hosts and report. */
export interface NetworkCheckResult {
  name: string;
  status: "pass" | "fail" | "skip";
  kind: NetworkCheckKind;
  preset?: NetworkPreset;
  /** Shown beside the result, e.g. "dry run not guaranteed". */
  label?: string;
  /** Lab checks only: the devices the check was pointed at. */
  hosts?: string[];
  command?: string;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  /** Always scrubbed: device config and tool output can carry passwords and keys. */
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  reason?: string;
  ended?: "timeout" | "no_start" | "blocked";
  /** Report checks only (kind "report"). */
  report?: HierConfigReport;
  /** Set when a skip means a tool, collection or model folder is missing: "not run", never a failure to fix. */
  notRun?: "tool" | "collection" | "platform" | "lab" | "vault" | "input";
}

export interface HierConfigReport {
  changeLines: number;
  undoLines: number;
  /** Scrubbed text of the lines to change and the lines to undo them. */
  remediation: string;
  rollback: string;
}

export const RESERVED_CHECK_NAMES = ["typecheck", "lint", "test", "build"] as const;
export const MAX_NAMED_CHECKS = 16;
const NAME = /^[a-z][a-z0-9-]{0,31}$/;

export function namedCheckNameError(label: string, name: string): string | undefined {
  if (NAME.test(name) && !(RESERVED_CHECK_NAMES as readonly string[]).includes(name)) return undefined;
  return `${label}.${name}: names are 1-32 lowercase letters, digits or dashes and cannot be typecheck, lint, test or build`;
}

export const LAB_IN_PROJECT_ERROR = "lab is your setting, not the project's: move it from .casper/project.yaml to ~/.casper/config.yaml";

type Mapping = Record<string, unknown>;
const isMapping = (value: unknown): value is Mapping => typeof value === "object" && value !== null && !Array.isArray(value);

const SPEC_KEYS = new Set(["kind", "run", "preset", "playbooks", "files", "inventory", "platform", "running", "intended", "models", "modules", "after", "timeout"]);

/** A project-relative path: no absolute paths, no "..", no NUL, and short. Folders may end in "/". */
function relativePath(label: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}: expected a path inside the project`);
  const text = value.trim();
  const parts = text.split(/[\\/]+/);
  if (text.length > 512 || text.includes("\0") || /^([a-zA-Z]:)?[\\/]/.test(text) || text.startsWith("~") || parts.includes("..")) {
    throw new Error(`${label}: expected a path inside the project, like checks/render.yml`);
  }
  return text;
}

function pathList(label: string, value: unknown, max = 64): string[] {
  const items = typeof value === "string" ? [value] : value;
  if (!Array.isArray(items) || !items.length) throw new Error(`${label}: expected one path or a list of paths`);
  if (items.length > max) throw new Error(`${label}: at most ${max} paths`);
  return items.map((item, index) => relativePath(`${label}[${index}]`, item));
}

function parseOne(label: string, value: unknown): NetworkCheckSpec {
  if (typeof value === "string") {
    if (!value.trim()) throw new Error(`${label}: expected a command or a mapping`);
    return { kind: "offline", run: value.trim(), after: "each-change" };
  }
  if (!isMapping(value)) throw new Error(`${label}: expected a command or a mapping`);
  for (const key of Object.keys(value)) if (!SPEC_KEYS.has(key)) throw new Error(`${label}.${key}: unknown setting`);
  const preset = value.preset;
  if (preset !== undefined && (typeof preset !== "string" || !NETWORK_PRESETS.includes(preset as NetworkPreset))) {
    throw new Error(`${label}.preset: expected one of ${NETWORK_PRESETS.join(", ")}`);
  }
  const typedPreset = preset as NetworkPreset | undefined;
  const derived: NetworkCheckKind = typedPreset && LAB_PRESETS.includes(typedPreset) ? "lab"
    : typedPreset && REPORT_PRESETS.includes(typedPreset) ? "report" : value.kind === "lab" ? "lab" : "offline";
  if (value.kind !== undefined && value.kind !== "offline" && value.kind !== "lab" && value.kind !== "report") {
    throw new Error(`${label}.kind: expected lab or report, or leave kind out for an ordinary check`);
  }
  if (value.kind !== undefined && value.kind !== derived) {
    // Casper never calls a check "offline" to the user: nothing stops one reaching the network yet.
    throw new Error(`${label}.kind: the ${typedPreset ?? "run"} check is ${derived === "offline" ? "an ordinary check; leave kind out" : `a ${derived} check`}`);
  }
  const spec: NetworkCheckSpec = { kind: derived };
  if (typedPreset) spec.preset = typedPreset;
  if (value.run !== undefined) {
    if (derived !== "offline" || typedPreset) {
      throw new Error(`${label}.run: ${derived === "offline" ? "use either run or preset, not both" : `a ${derived} check never takes a free-form run command`}`);
    }
    if (typeof value.run !== "string" || !value.run.trim()) throw new Error(`${label}.run: expected a command`);
    spec.run = value.run.trim();
  }
  if (!spec.run && !spec.preset) throw new Error(`${label}: set run (a command) or preset (${NETWORK_PRESETS.join(", ")})`);
  if (value.playbooks !== undefined) spec.playbooks = pathList(`${label}.playbooks`, value.playbooks);
  if (value.files !== undefined) spec.files = pathList(`${label}.files`, value.files);
  if (value.models !== undefined) spec.models = pathList(`${label}.models`, value.models, 16);
  if (value.modules !== undefined) spec.modules = pathList(`${label}.modules`, value.modules);
  if (value.inventory !== undefined) spec.inventory = relativePath(`${label}.inventory`, value.inventory);
  if (value.running !== undefined) spec.running = relativePath(`${label}.running`, value.running);
  if (value.intended !== undefined) spec.intended = relativePath(`${label}.intended`, value.intended);
  if (value.platform !== undefined) {
    if (value.platform !== "aoscx" && value.platform !== "junos") throw new Error(`${label}.platform: expected aoscx or junos`);
    spec.platform = value.platform;
  }
  if (value.after !== undefined) {
    if (value.after !== "each-change" && value.after !== "ask") throw new Error(`${label}.after: expected each-change or ask`);
    if (derived !== "offline") throw new Error(`${label}.after: ${derived} checks never run on their own; you start them with /verify`);
    spec.after = value.after;
  }
  if (derived === "offline") spec.after ??= "each-change";
  if (value.timeout !== undefined) {
    if (typeof value.timeout !== "number" || !Number.isInteger(value.timeout) || value.timeout < 1 || value.timeout > 3600) {
      throw new Error(`${label}.timeout: expected whole seconds from 1 to 3600`);
    }
    spec.timeout = value.timeout;
  }

  switch (spec.preset) {
    case "ansible-syntax": case "ansible-render":
      if (!spec.playbooks) throw new Error(`${label}: the ${spec.preset} check needs playbooks (playbooks: [site.yml])`);
      break;
    case "junoser":
      if (!spec.files) throw new Error(`${label}: the junoser check needs files (files: [configs/])`);
      break;
    case "yanglint":
      if (!spec.models || !spec.modules || !spec.files) {
        throw new Error(`${label}: the yanglint check needs models (folders), modules (.yang files) and files (data to check)`);
      }
      break;
    case "hier-config":
      if (!spec.platform || !spec.running || !spec.intended) {
        throw new Error(`${label}: the hier-config report needs platform (aoscx or junos), running and intended files`);
      }
      break;
    case "junos-commit":
      if (!spec.files || spec.files.length !== 1) throw new Error(`${label}: the junos-commit check needs one change file (files: [change.set])`);
      break;
    case "ansible-check":
      if (!spec.playbooks) throw new Error(`${label}: the ansible-check check needs playbooks (playbooks: [site.yml])`);
      break;
  }
  if (spec.kind === "lab" && !spec.inventory) throw new Error(`${label}: a lab check needs an inventory (inventory: path/to/lab.yml)`);
  return spec;
}

/** Parse the `verify.checks` mapping. `label` is where it came from, e.g. "verify.checks". */
export function parseNetworkChecks(value: unknown, label = "verify.checks"): Record<string, NetworkCheckSpec> {
  if (value === undefined || value === null) return {};
  if (!isMapping(value)) throw new Error(`${label}: expected a mapping of check names`);
  const names = Object.keys(value);
  if (names.length > MAX_NAMED_CHECKS) throw new Error(`${label}: at most ${MAX_NAMED_CHECKS} named checks`);
  const checks: Record<string, NetworkCheckSpec> = {};
  for (const name of names) {
    const error = namedCheckNameError(label, name);
    if (error) throw new Error(error);
    checks[name] = parseOne(`${label}.${name}`, value[name]);
  }
  return checks;
}

export function isLabCheck(spec: NetworkCheckSpec): boolean { return spec.kind === "lab"; }

/** Checks that may run after each change: offline ones not set to "ask". Never lab or report checks. */
export function autoNetworkCheckNames(checks: Record<string, NetworkCheckSpec>): string[] {
  return Object.entries(checks).filter(([, spec]) => spec.kind === "offline" && spec.after !== "ask").map(([name]) => name);
}

/** Names the model may run through casper_check: offline and report checks, never lab ones. */
export function modelNetworkCheckNames(checks: Record<string, NetworkCheckSpec>): string[] {
  return Object.entries(checks).filter(([, spec]) => spec.kind !== "lab").map(([name]) => name);
}

const HOSTNAME = /^[a-z0-9_]([a-z0-9_.-]{0,252})$/i;

function labEntry(label: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}: expected a hostname, an IP address or a range like 10.99.0.0/24`);
  const text = value.trim();
  const slash = text.indexOf("/");
  if (slash >= 0) {
    const address = text.slice(0, slash);
    const bits = text.slice(slash + 1);
    const family = isIP(address);
    const max = family === 4 ? 32 : 128;
    if (!family || !/^\d{1,3}$/.test(bits) || Number(bits) > max) throw new Error(`${label}: ${text} is not an IP range like 10.99.0.0/24`);
    return text.toLowerCase();
  }
  if (isIP(text)) return text.toLowerCase();
  if (/[*?[\]]/.test(text)) throw new Error(`${label}: ${text}: write exact names, no wildcards`);
  if (!HOSTNAME.test(text)) throw new Error(`${label}: ${text} is not a hostname, an IP address or an IP range`);
  return text.toLowerCase();
}

/**
 * Parse `lab:` from a settings layer. `source` "project" always throws: the
 * lab list is the owner's statement about their own gear.
 */
export function parseLabSettings(value: unknown, source: "user" | "profile" | "project", label = "lab"): LabSettings | undefined {
  if (value === undefined || value === null) return undefined;
  if (source === "project") throw new Error(LAB_IN_PROJECT_ERROR);
  if (!isMapping(value)) throw new Error(`${label}: expected a mapping with hosts: [...]`);
  for (const key of Object.keys(value)) if (key !== "hosts") throw new Error(`${label}.${key}: unknown setting`);
  const hosts = value.hosts;
  if (!Array.isArray(hosts)) throw new Error(`${label}.hosts: expected a list of hostnames, IP addresses or ranges`);
  if (hosts.length > 1024) throw new Error(`${label}.hosts: at most 1024 entries`);
  return { hosts: [...new Set(hosts.map((item, index) => labEntry(`${label}.hosts[${index}]`, item)))] };
}

/** A later layer (the profile) replaces an earlier one (the user file) as a whole: no merging of lab lists. */
export function mergeLabSettings(...layers: (LabSettings | undefined)[]): LabSettings | undefined {
  let result: LabSettings | undefined;
  for (const layer of layers) if (layer) result = { hosts: [...layer.hosts] };
  return result;
}
