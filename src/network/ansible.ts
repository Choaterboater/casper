import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { MAX_SCAN_BYTES, readSmallText, resolveInside } from "./files";
import type { NetworkCheckSpec } from "./spec";

/**
 * Ansible detection and playbook reading. Everything here only reads files:
 * a bounded walk (at most 200 YAML files of 256 KiB each, five folders deep)
 * that never follows links, and no Ansible process.
 */

export const MAX_YAML_FILES = 200;
const MAX_DEPTH = 5;
/** Files and folders looked at in one scan; a real Ansible project is far smaller. */
const MAX_ENTRIES = 5000;
const SKIP_FOLDERS = new Set([".git", "node_modules", ".venv", "venv", ".tox", "collections", "roles", ".casper", "__pycache__", "dist", "build"]);

/** Collections whose modules talk to network devices. */
export const NETWORK_COLLECTIONS = ["arubanetworks.aoscx", "junipernetworks.junos", "juniper.device"] as const;
const SHORT_PREFIXES: Record<string, string> = { aoscx_: "arubanetworks.aoscx", junos_: "junipernetworks.junos" };

const TASK_KEYWORDS = new Set([
  "name", "when", "register", "vars", "tags", "become", "become_user", "become_method", "become_flags", "become_exe", "loop",
  "loop_control", "notify", "delegate_to", "delegate_facts", "run_once", "ignore_errors", "ignore_unreachable", "changed_when",
  "failed_when", "until", "retries", "delay", "environment", "no_log", "check_mode", "diff", "connection", "any_errors_fatal",
  "args", "async", "poll", "collections", "module_defaults", "debugger", "throttle", "timeout", "listen", "remote_user", "port",
  "block", "rescue", "always", "action", "local_action",
]);
/** Local modules a render-only playbook may also use: they show or check values, or write files locally. */
const RENDER_HELPERS = new Set(["debug", "set_fact", "assert", "fail", "copy", "template"]);

export interface TaskInfo { module: string; collection?: string; state?: unknown; line?: number }
export interface PlaybookInfo {
  /** Project-relative, forward slashes. */
  file: string;
  hosts: string[];
  collections: string[];
  tasks: TaskInfo[];
  /** Every task that talks to devices has state: rendered (and there is at least one), plays target localhost only, nothing else runs. */
  renderOnly: boolean;
  /** Why the playbook is not render-only, when it is not. */
  renderProblem?: string;
  /** delegate_to / add_host lines. */
  reach: { what: string; line: number }[];
}

export interface AnsibleDetection {
  signals: string[];
  playbooks: PlaybookInfo[];
  collections: string[];
  frameworks: string[];
  /** Ready-made checks, keyed by name. A project's own verify.checks entries win over these. */
  checks: Record<string, NetworkCheckSpec>;
}

type Mapping = Record<string, unknown>;
const isMapping = (value: unknown): value is Mapping => typeof value === "object" && value !== null && !Array.isArray(value);
const FQCN = /^([a-z0-9_]+)\.([a-z0-9_]+)\.([a-z0-9_]+)$/;

function yamlValue(text: string): unknown {
  // Unknown tags (!vault, !unsafe) stay strings; nothing is resolved or executed.
  return parse(text, { logLevel: "silent", maxAliasCount: 50, uniqueKeys: false, strict: false });
}

function lineOf(text: string, pattern: RegExp): number | undefined {
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.replace(/\s#.*$/, "");
    if (!/^\s*#/.test(line) && pattern.test(line)) return index + 1;
  }
  return undefined;
}

function taskModule(task: Mapping, playCollections: string[]): TaskInfo | undefined {
  let module: string | undefined;
  let args: unknown;
  for (const key of Object.keys(task)) {
    if (TASK_KEYWORDS.has(key) || key.startsWith("with_")) continue;
    module = key;
    args = task[key];
    break;
  }
  if (!module && typeof task.action === "string") module = task.action.trim().split(/\s+/)[0];
  if (!module && typeof task.local_action === "string") module = task.local_action.trim().split(/\s+/)[0];
  if (!module) return undefined;
  const match = FQCN.exec(module);
  let collection = match ? `${match[1]}.${match[2]}` : undefined;
  if (!collection) {
    for (const [prefix, candidate] of Object.entries(SHORT_PREFIXES)) {
      if (module.startsWith(prefix) && playCollections.includes(candidate)) collection = candidate;
    }
  }
  const state = isMapping(args) ? args.state : isMapping(task.args) ? task.args.state : undefined;
  return { module, collection, state };
}

function collectTasks(list: unknown, playCollections: string[], into: TaskInfo[], nested: { roles: boolean; imports: string[] }, depth = 0): void {
  if (!Array.isArray(list) || depth > 8) return;
  for (const item of list) {
    if (!isMapping(item)) continue;
    for (const key of ["block", "rescue", "always"]) if (Array.isArray(item[key])) collectTasks(item[key], playCollections, into, nested, depth + 1);
    if (Array.isArray(item.block)) continue;
    const info = taskModule(item, playCollections);
    if (!info) continue;
    const bare = info.module.replace(/^ansible\.(builtin|legacy)\./, "");
    if (/^(include|import)_(tasks|role)$|^include$|^include_vars$/.test(bare)) nested.imports.push(bare);
    into.push(info);
  }
}

function asList(value: unknown): string[] {
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

/** Read one playbook's text. Returns undefined when it is not a playbook (a list of plays with hosts:). */
export function readPlaybook(file: string, text: string): PlaybookInfo | undefined {
  let value: unknown;
  try { value = yamlValue(text); } catch { return undefined; }
  if (!Array.isArray(value) || !value.length) return undefined;
  const plays = value.filter(isMapping);
  if (!plays.length || !plays.every((play) => "hosts" in play || "import_playbook" in play || "ansible.builtin.import_playbook" in play)) return undefined;
  if (!plays.some((play) => "hosts" in play)) return undefined;
  const hosts: string[] = [];
  const collections = new Set<string>();
  const tasks: TaskInfo[] = [];
  const nested = { roles: false, imports: [] as string[] };
  let importsPlaybook = false;
  for (const play of plays) {
    if (!("hosts" in play)) { importsPlaybook = true; continue; }
    hosts.push(...asList(play.hosts));
    const playCollections = asList(play.collections);
    for (const name of playCollections) collections.add(name);
    if (Array.isArray(play.roles) && play.roles.length) nested.roles = true;
    for (const key of ["pre_tasks", "tasks", "post_tasks", "handlers"]) collectTasks(play[key], playCollections, tasks, nested);
  }
  for (const task of tasks) if (task.collection) collections.add(task.collection);
  for (const task of tasks) task.line = lineOf(text, new RegExp(`^\\s*-?\\s*${task.module.replace(/\./g, "\\.")}\\s*:`));

  const reach: PlaybookInfo["reach"] = [];
  for (const what of ["delegate_to", "add_host", "local_action"]) {
    const line = lineOf(text, new RegExp(`^\\s*-?\\s*(ansible\\.builtin\\.)?${what}\\s*:`));
    if (line) reach.push({ what, line });
  }

  const deviceTasks = tasks.filter((task) => task.collection && (NETWORK_COLLECTIONS as readonly string[]).includes(task.collection));
  let renderProblem: string | undefined;
  if (importsPlaybook || nested.roles || nested.imports.length) renderProblem = "it pulls in other files (roles, imports or includes)";
  else if (reach.length) renderProblem = `it uses ${reach[0]!.what} (line ${reach[0]!.line})`;
  else if (/\b(lookup|query|q)\s*\(\s*['"](pipe|url|env|file)['"]/.test(text)) renderProblem = "it uses a lookup that reads outside the playbook";
  else if (hosts.some((host) => !["localhost", "all", "127.0.0.1"].includes(host))) renderProblem = `a play targets ${hosts.find((host) => !["localhost", "all", "127.0.0.1"].includes(host))}, not localhost`;
  else if (!deviceTasks.length) renderProblem = "no task renders device config";
  else {
    for (const task of tasks) {
      const isDevice = deviceTasks.includes(task);
      const bare = task.module.replace(/^ansible\.(builtin|legacy)\./, "");
      if (isDevice && task.state !== "rendered") { renderProblem = `task ${task.module}${task.line ? ` (line ${task.line})` : ""} is not state: rendered`; break; }
      if (!isDevice && !RENDER_HELPERS.has(bare)) { renderProblem = `task ${task.module}${task.line ? ` (line ${task.line})` : ""} is not a render step`; break; }
    }
  }
  return {
    file, hosts, collections: [...collections].sort(), tasks, renderOnly: !renderProblem,
    ...(renderProblem ? { renderProblem } : {}), reach,
  };
}

/** Breadth-first, so a project's own playbooks (near the top) come before deep folders, and bounded by entries
 * looked at: opened on a huge folder (a home folder, with ~/Library) the walk took half a minute. */
async function findYaml(root: string): Promise<string[]> {
  const found: string[] = [];
  let looked = 0;
  let level: string[] = [""];
  for (let depth = 0; depth <= MAX_DEPTH && level.length; depth++) {
    const next: string[] = [];
    for (const relative of level) {
      let names: string[];
      try { names = (await readdir(path.join(root, relative))).sort(); } catch { continue; }
      for (const name of names) {
        if (found.length >= MAX_YAML_FILES || ++looked > MAX_ENTRIES) return found;
        const child = relative ? path.posix.join(relative, name) : name;
        let info;
        try { info = await lstat(path.join(root, child)); } catch { continue; }
        // lstat: a link is neither a file nor a folder here, so links out are never followed.
        if (info.isDirectory()) {
          if (!SKIP_FOLDERS.has(name) && !name.startsWith(".") && !["group_vars", "host_vars", "templates", "files"].includes(name)) next.push(child);
        } else if (info.isFile() && /\.ya?ml$/i.test(name) && info.size <= MAX_SCAN_BYTES) found.push(child);
      }
    }
    level = next;
  }
  return found;
}

async function exists(root: string, relative: string): Promise<boolean> {
  try { return (await lstat(path.join(root, relative))).isFile(); } catch { return false; }
}

/** Find Ansible in a project and the ready-made checks that fit it. */
export async function detectAnsible(root: string): Promise<AnsibleDetection | undefined> {
  const signals: string[] = [];
  for (const name of ["ansible.cfg", "galaxy.yml", "collections/requirements.yml", "requirements.yml"]) {
    if (await exists(root, name)) signals.push(name);
  }
  const playbooks: PlaybookInfo[] = [];
  for (const file of await findYaml(root)) {
    let text: string;
    try { text = await readSmallText(path.join(root, file)); } catch { continue; }
    if (!/^\s*-?\s*hosts\s*:/m.test(text)) continue;
    const info = readPlaybook(file, text);
    if (info) playbooks.push(info);
  }
  if (signals.includes("requirements.yml") && !playbooks.length && signals.length === 1) return undefined;
  if (!signals.length && !playbooks.length) return undefined;
  const collections = [...new Set(playbooks.flatMap((playbook) => playbook.collections))].sort();
  const frameworks: string[] = [];
  if (collections.includes("arubanetworks.aoscx")) frameworks.push("aoscx");
  if (collections.some((name) => name === "junipernetworks.junos" || name === "juniper.device")) frameworks.push("junos");

  const checks: Record<string, NetworkCheckSpec> = {};
  const uses = (playbook: PlaybookInfo, ...names: string[]) => playbook.collections.some((name) => names.includes(name));
  const aruba = playbooks.filter((playbook) => uses(playbook, "arubanetworks.aoscx")).map((playbook) => playbook.file);
  const render = playbooks.filter((playbook) => playbook.renderOnly && uses(playbook, "junipernetworks.junos")).map((playbook) => playbook.file);
  const junos = playbooks.filter((playbook) => uses(playbook, "junipernetworks.junos", "juniper.device") && !render.includes(playbook.file)).map((playbook) => playbook.file);
  if (aruba.length) checks["aruba-syntax"] = { kind: "offline", preset: "ansible-syntax", playbooks: aruba.slice(0, 16), after: "each-change" };
  if (junos.length) checks["junos-syntax"] = { kind: "offline", preset: "ansible-syntax", playbooks: junos.slice(0, 16), after: "each-change" };
  if (render.length) checks["junos-render"] = { kind: "offline", preset: "ansible-render", playbooks: render.slice(0, 16), after: "each-change" };
  return { signals, playbooks, collections, frameworks, checks };
}

/** Read one declared playbook from the project (inside the root, bounded, never through a link out). */
export async function readProjectPlaybook(root: string, relative: string): Promise<PlaybookInfo> {
  const absolute = await resolveInside(root, relative);
  const info = readPlaybook(relative, await readSmallText(absolute));
  if (!info) throw new Error(`${relative} is not an Ansible playbook (a list of plays with hosts:)`);
  return info;
}
