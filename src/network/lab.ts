import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import path from "node:path";
import { parse } from "yaml";
import { readPlaybook } from "./ansible";
import { MAX_SCAN_BYTES, readSmallText, resolveInside } from "./files";
import { hasLineControls, lineText } from "../tui/format";
import { runArgv } from "./run";
import type { LabSettings } from "./spec";

/**
 * The lab gate. Lab checks reach real devices, so they run only when:
 * - you started them (/verify <name> and a numbered choice; never the AI, never auto mode),
 * - you declared your lab in ~/.casper/config.yaml or a profile (lab.hosts: exact
 *   hostnames, IP addresses and ranges; no DNS lookups, no guessing from names),
 * - every host in the check's inventory is on that list, and
 * - the playbook text does not name other targets (delegate_to, add_host, ansible_host, ProxyCommand ...).
 *
 * This is a check of the inventory and the playbook text. It cannot stop other
 * network traffic: that needs the shell sandbox, which is not there yet.
 * Reused unchanged by the later lab gate.
 */

export const LAB_LIMIT_NOTE = "Casper checked the inventory and the playbook text; it cannot block other network traffic yet.";
export const labModelRefusal = (name: string): string => `Lab checks run only when you start them: /verify ${name}`;

export interface LabHost {
  /** The inventory name. */
  name: string;
  /** Where Ansible connects: ansible_host (or ansible_ssh_host) when set, otherwise the name. */
  address: string;
}


function toHost(value: string | LabHost): LabHost {
  return typeof value === "string" ? { name: value, address: value } : value;
}

function matcher(settings: LabSettings): { ips: BlockList; names: Set<string> } {
  const ips = new BlockList();
  const names = new Set<string>();
  for (const entry of settings.hosts) {
    const slash = entry.indexOf("/");
    if (slash >= 0) {
      const address = entry.slice(0, slash);
      const family = isIP(address) === 6 ? "ipv6" : "ipv4";
      ips.addSubnet(address, Number(entry.slice(slash + 1)), family);
    } else if (isIP(entry)) ips.addAddress(entry, isIP(entry) === 6 ? "ipv6" : "ipv4");
    else names.add(entry.toLowerCase());
  }
  return { ips, names };
}

function onList(target: string, lab: { ips: BlockList; names: Set<string> }): boolean {
  const text = target.trim().replace(/^\[(.*)\]$/, "$1");
  const family = isIP(text);
  if (family) return lab.ips.check(text, family === 6 ? "ipv6" : "ipv4");
  // Exact, case-folded text only. A trailing dot is the same DNS name.
  return lab.names.has(text.toLowerCase().replace(/\.$/, ""));
}

/** The hosts not on your lab list (all of them when you have none). Only for the box's warning: any device may be checked. */
export function notLabHosts(hosts: readonly LabHost[], settings: LabSettings | undefined): LabHost[] {
  if (!settings || !settings.hosts.length) return [...hosts];
  const lab = matcher(settings);
  return hosts.filter((host) => !onList(host.address, lab));
}

export const describeHost = (host: LabHost): string => host.address !== host.name ? `${host.name} (${host.address})` : host.name;

export interface ReachFinding { file: string; line: number; what: string }

export function reachWarningText(finding: ReachFinding): string {
  return `${finding.file} uses ${finding.what} (line ${finding.line}), so it can reach devices not listed here.`;
}

/** Host variables that can send Ansible somewhere other than the listed address. */
const PROXY_VARIABLES = ["ansible_ssh_common_args", "ansible_ssh_extra_args", "ansible_ssh_args", "ansible_paramiko_proxy_command", "ansible_netconf_ssh_config", "ansible_psrp_proxy", "ansible_httpapi_proxy"];

/** Host variables that name a program Ansible starts on this machine. */
const LOCAL_PROGRAM_VARIABLES = ["ansible_python_interpreter", "ansible_interpreter_python", "ansible_ssh_executable", "ansible_shell_executable",
  "ansible_become_exe", "ansible_scp_executable", "ansible_sftp_executable"];

/** A program the project could have supplied: a relative path, a template, a command line, or a path inside the project.
 * A plain absolute path elsewhere (/usr/bin/python3, the usual setting) is not. */
function projectProgram(value: string, root: string | undefined): boolean {
  if (/\{\{|\{%|\s|[;&|`$<>]/.test(value) || !path.isAbsolute(value)) return true;
  if (!root) return false;
  const relative = path.relative(root, value);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

export interface InventoryHosts { hosts: LabHost[]; problem?: string; warnings?: string[]; /** Digest of every host's variables. */ vars?: string }

/** Read `ansible-inventory --list` JSON: every host and where it connects. */
export function inventoryHostsFromJson(text: string, root?: string): InventoryHosts {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { hosts: [], problem: "ansible-inventory did not print JSON" }; }
  if (typeof value !== "object" || value === null) return { hosts: [], problem: "ansible-inventory did not print JSON" };
  const data = value as Record<string, unknown>;
  const meta = data._meta as { hostvars?: Record<string, Record<string, unknown>> } | undefined;
  const hostvars = meta?.hostvars ?? {};
  const names = new Set<string>(Object.keys(hostvars));
  for (const [group, entry] of Object.entries(data)) {
    if (group === "_meta" || typeof entry !== "object" || entry === null) continue;
    const list = (entry as { hosts?: unknown }).hosts;
    if (Array.isArray(list)) for (const name of list) if (typeof name === "string") names.add(name);
  }
  const hosts: LabHost[] = [];
  const warnings: string[] = [];
  for (const name of [...names].sort()) {
    const vars = hostvars[name] ?? {};
    // One line per device in the box: a name with a line break could add lines of its own.
    if (hasLineControls(name)) return { hosts, problem: `host ${JSON.stringify(name)} holds control characters` };
    for (const key of LOCAL_PROGRAM_VARIABLES) {
      const setting = vars[key];
      if (typeof setting === "string" && setting.trim() && projectProgram(setting.trim(), root)) {
        warnings.push(`Host ${name} sets ${key} to ${lineText(setting.trim()).slice(0, 80)}, so the run starts that program on this machine.`);
        break;
      }
    }
    // A jump host or proxy is normal on a network; the box names it, and you decide.
    for (const key of PROXY_VARIABLES) {
      const setting = vars[key];
      if (setting !== undefined && setting !== null && String(setting).trim() !== "") {
        warnings.push(`Host ${name} sets ${key}, so the connection can go through another machine.`);
        break;
      }
    }
    const address = vars.ansible_host ?? vars.ansible_ssh_host;
    if (address !== undefined && typeof address !== "string") return { hosts, problem: `host ${name} has an ansible_host that is not plain text` };
    if (typeof address === "string" && /\{\{|\{%/.test(address)) return { hosts, problem: `host ${name} builds ansible_host from a template` };
    if (typeof address === "string" && hasLineControls(address)) return { hosts, problem: `host ${name} has an ansible_host that holds control characters` };
    hosts.push({ name, address: typeof address === "string" && address.trim() ? address.trim() : name });
  }
  const vars = createHash("sha256").update(JSON.stringify([...names].sort().map((name) => [name, hostvars[name] ?? {}]))).digest("hex");
  return { hosts, vars, ...(warnings.length ? { warnings } : {}) };
}

/** Only plain inventory files: YAML or INI text, not a program, not a link out of the project. */
export async function checkInventoryFile(root: string, relative: string): Promise<string> {
  const absolute = await resolveInside(root, relative);
  const info = await lstat(absolute);
  if (!info.isFile()) throw new Error(`the inventory ${relative} is not a file; Casper reads only plain inventory files`);
  if (process.platform !== "win32" && (info.mode & 0o111)) {
    throw new Error(`the inventory ${relative} is a program (it is executable); Casper reads only plain YAML or INI inventory files`);
  }
  if (!/\.(ya?ml|ini|cfg)$|^[^.]+$/i.test(path.basename(absolute))) {
    throw new Error(`the inventory ${relative} is not a YAML or INI file`);
  }
  return absolute;
}

export interface LabHostsOptions { cwd: string; env: Record<string, string>; ansibleInventory: string; timeoutMs?: number; signal?: AbortSignal }

/**
 * Run `ansible-inventory -i <inventory> --list` (argument list, no shell,
 * bounded output, timeout). Casper's own ansible.cfg (in env) enables only the
 * static host_list, yaml and ini inventory plugins.
 */
export async function labHosts(inventory: string, options: LabHostsOptions): Promise<InventoryHosts & { vault?: boolean }> {
  const result = await runArgv(options.ansibleInventory, ["-i", inventory, "--list"], {
    cwd: options.cwd, env: options.env, timeoutMs: options.timeoutMs ?? 60_000, signal: options.signal, outputBytes: 2 * 1024 * 1024,
  });
  if (/no vault secrets (were )?found|vault password/i.test(result.stderr)) return { hosts: [], vault: true, problem: "the inventory needs an Ansible vault password" };
  if (result.exitCode !== 0) return { hosts: [], problem: `ansible-inventory could not read ${path.basename(inventory)}${result.reason ? ` (${result.reason})` : ""}` };
  if (result.truncated) return { hosts: [], problem: "the inventory is too large to check" };
  return inventoryHostsFromJson(result.stdout, options.cwd);
}

/** Lines that can point a playbook at hosts beyond its inventory, or run things Casper cannot check. */
const REACH_PATTERNS: { what: string; re: RegExp }[] = [
  { what: "check_mode: false (this task really runs, even under --check)", re: /^\s*-?\s*check_mode\s*:\s*(false|no|False|No)\b/ },
  { what: "delegate_to", re: /^\s*-?\s*delegate_to\s*:/ },
  { what: "add_host", re: /^\s*-?\s*(ansible\.builtin\.)?add_host\s*:/ },
  { what: "local_action", re: /^\s*-?\s*local_action\s*:/ },
  { what: "import_playbook", re: /^\s*-?\s*(ansible\.builtin\.)?(import|include)_playbook\s*:/ },
  { what: "ansible_host", re: /\bansible_(ssh_)?host\b/ },
  { what: "an SSH proxy setting", re: /\b(ProxyCommand|ProxyJump)\b|\bansible_(ssh_common_args|ssh_extra_args|ssh_args|paramiko_proxy_command|netconf_ssh_config)\b/i },
  { what: "a task's own target (provider)", re: /^\s*-?\s*provider\s*:/ },
  { what: "a task's own target (host)", re: /^\s+-?\s*host\s*:/ },
  { what: "a URL", re: /^\s*-?\s*(url|api_url|base_url)\s*:/ },
  { what: "a command module", re: /^\s*-?\s*(ansible\.(builtin|legacy)\.)?(shell|command|raw|script|uri|get_url|expect)\s*:/ },
  { what: "a lookup that runs or fetches", re: /\b(lookup|query|q)\s*\(\s*['"](pipe|url|ansible\.builtin\.(pipe|url))['"]/ },
];

/** Every line of a file that matches a reach pattern (one finding per line). */
function scanText(file: string, text: string): ReachFinding[] {
  const found: ReachFinding[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^\s*#/.test(line)) continue;
    const body = line.replace(/\s+#.*$/, "");
    const pattern = REACH_PATTERNS.find((candidate) => candidate.re.test(body));
    if (pattern) found.push({ file, line: index + 1, what: pattern.what });
  }
  return found;
}

/** Folders next to a playbook that Ansible loads as local code (they run on this machine, outside the sandbox). */
const PLUGIN_FOLDERS = ["library", "module_utils", "action_plugins", "filter_plugins", "lookup_plugins", "callback_plugins", "connection_plugins", "plugins",
  "vars_plugins", "test_plugins", "strategy_plugins", "cache_plugins", "terminal_plugins", "cliconf_plugins", "netconf_plugins", "httpapi_plugins",
  "become_plugins", "inventory_plugins", "shell_plugins", "doc_fragments"];
const PLUGIN_CODE = "local plugin code that runs on this machine";

/** Plugin folders inside `folder` (next to a playbook, or in a role), as `folder/name/` paths. */
async function pluginFolders(root: string, folder: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of PLUGIN_FOLDERS) {
    const relative = path.posix.join(folder, name);
    try { if ((await lstat(path.join(root, relative))).isDirectory()) found.push(`${relative}/`); } catch { /* none */ }
  }
  return found;
}

const INCLUDE = /^\s*-?\s*(?:ansible\.builtin\.)?(include_tasks|import_tasks|include_vars|include|include_role|import_role)\s*:\s*(.*)$/;

/**
 * Scan a playbook and every file it pulls in for ways to reach hosts beyond the
 * inventory: the playbook, vars_files, included task files, roles in the
 * project's roles/ folder, and group_vars/host_vars next to the playbook. A file
 * Casper cannot read ahead (a templated name, a role from a collection) is itself a refusal.
 * Stricter than Ansible needs, and still only a text scan.
 */
export async function scanPlaybookReach(root: string, playbook: string): Promise<ReachFinding[]> {
  const findings: ReachFinding[] = [];
  const note = (finding: ReachFinding) => { if (findings.length < 200) findings.push(finding); };
  for (const file of await pluginFolders(root, path.posix.dirname(playbook))) note({ file, line: 1, what: PLUGIN_CODE });
  // Ansible looks in collections/ next to the playbook before your installed collections, so it can replace a module.
  const collections = path.posix.join(path.posix.dirname(playbook), "collections");
  try {
    if ((await lstat(path.join(root, collections))).isDirectory()) {
      note({ file: `${collections}/`, line: 1, what: "a collections folder next to the playbook, whose local code Ansible loads before your installed collections" });
    }
  } catch { /* none */ }
  const plugins = (files: string[]) => { for (const file of files) note({ file, line: 1, what: PLUGIN_CODE }); };
  const seen = new Set<string>();
  const queue: string[] = [playbook];
  const playbookDir = path.posix.dirname(playbook);
  for (const folder of ["group_vars", "host_vars"]) queue.push(...await listYaml(root, path.posix.join(playbookDir, folder)));
  let budget = 200;
  while (queue.length) {
    const relative = queue.shift()!;
    if (seen.has(relative)) continue;
    seen.add(relative);
    if (--budget < 0) { note({ file: playbook, line: 1, what: "more than 200 files (the rest not scanned)" }); break; }
    let absolute: string;
    let text: string;
    try {
      absolute = await resolveInside(root, relative);
      text = await readSmallText(absolute, MAX_SCAN_BYTES);
    } catch {
      note({ file: relative, line: 1, what: "a file Casper cannot read" });
      continue;
    }
    for (const finding of scanText(relative, text)) note(finding);
    const base = path.posix.dirname(relative);
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index++) {
      const include = INCLUDE.exec(lines[index]!);
      if (include) {
        const kind = include[1]!;
        let target = include[2]!.trim().replace(/^['"]|['"]$/g, "");
        if (kind.endsWith("_role")) {
          const name = /name\s*:\s*['"]?([\w.-]+)/.exec(target)?.[1] ?? lines[index + 1]?.match(/^\s*name\s*:\s*['"]?([\w.-]+)/)?.[1];
          if (!name) { note({ file: relative, line: index + 1, what: `${kind} with a name Casper cannot read ahead` }); continue; }
          const role = await roleFiles(root, base, name, plugins);
          if (!role) { note({ file: relative, line: index + 1, what: `role ${name}, which is not in the project's roles/ folder` }); continue; }
          queue.push(...role);
          continue;
        }
        if (!target || target.includes("{{") || target.startsWith("/") || target.split("/").includes("..")) {
          note({ file: relative, line: index + 1, what: `${kind} with a file Casper cannot read ahead` });
          continue;
        }
        queue.push(path.posix.normalize(path.posix.join(base, target)));
      }
    }
    const parsed = relative === playbook ? readPlaybook(relative, text) : undefined;
    if (relative === playbook) {
      if (!parsed) { note({ file: relative, line: 1, what: "a file that is not a playbook" }); continue; }
      let value: unknown;
      try { value = parse(text, { logLevel: "silent", maxAliasCount: 50, uniqueKeys: false, strict: false }); } catch { value = undefined; }
      for (const play of Array.isArray(value) ? value : []) {
        if (typeof play !== "object" || play === null) continue;
        const record = play as Record<string, unknown>;
        const files = typeof record.vars_files === "string" ? [record.vars_files] : Array.isArray(record.vars_files) ? record.vars_files : [];
        for (const file of files) {
          if (typeof file !== "string" || file.includes("{{") || file.startsWith("/") || file.split("/").includes("..")) {
            note({ file: relative, line: lineNumber(text, /vars_files/), what: "vars_files Casper cannot read ahead" });
            continue;
          }
          queue.push(path.posix.normalize(path.posix.join(base, file)));
        }
        const roles = Array.isArray(record.roles) ? record.roles : [];
        for (const role of roles) {
          const name = typeof role === "string" ? role : typeof role === "object" && role !== null ? (role as Record<string, unknown>).role ?? (role as Record<string, unknown>).name : undefined;
          if (typeof name !== "string" || name.includes("{{")) { note({ file: relative, line: lineNumber(text, /roles\s*:/), what: "a role Casper cannot read ahead" }); continue; }
          const files = await roleFiles(root, base, name, plugins);
          if (!files) { note({ file: relative, line: lineNumber(text, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))), what: `role ${name}, which is not in the project's roles/ folder` }); continue; }
          queue.push(...files);
        }
      }
    }
  }
  return findings;
}

function lineNumber(text: string, re: RegExp): number {
  const index = text.split("\n").findIndex((line) => re.test(line));
  return index < 0 ? 1 : index + 1;
}

async function listYaml(root: string, folder: string, depth = 0): Promise<string[]> {
  if (depth > 3) return [];
  let absolute: string;
  try { absolute = await resolveInside(root, folder); } catch { return []; }
  let names: string[];
  try { names = (await readdir(absolute)).sort(); } catch { return []; }
  const files: string[] = [];
  for (const name of names) {
    const child = path.posix.join(folder, name);
    const info = await lstat(path.join(absolute, name)).catch(() => undefined);
    if (!info) continue;
    if (info.isDirectory()) files.push(...await listYaml(root, child, depth + 1));
    else if (info.isFile() && (/\.ya?ml$/i.test(name) || !name.includes("."))) files.push(child);
    else if (info.isSymbolicLink()) files.push(child); // resolveInside decides; a link out is refused
  }
  return files;
}

async function roleFiles(root: string, base: string, name: string, onPlugins?: (folders: string[]) => void): Promise<string[] | undefined> {
  if (!/^[\w-]+$/.test(name)) return undefined;
  for (const folder of [path.posix.join(base, "roles", name), path.posix.join("roles", name)]) {
    try {
      const absolute = await resolveInside(root, folder);
      if ((await lstat(absolute)).isDirectory()) {
        // A role's own library/, filter_plugins/ … run on this machine like those next to the playbook.
        onPlugins?.(await pluginFolders(root, folder));
        return listYaml(root, folder);
      }
    } catch { /* try the next place */ }
  }
  return undefined;
}

/** A fingerprint of what the user agreed to: the check, the inventory file, the hosts and the change file. */
/**
 * What "Yes, always for this project" is bound to: the check, the inventory, every host and its address, the inventory's
 * host variables, and each change file by path and contents. Any edit (by you or the AI) asks again.
 */
export function labApprovalKey(check: string, parts: { inventory: string; hosts: readonly LabHost[]; files?: readonly string[]; contents?: readonly string[]; vars?: string }): string {
  const hash = createHash("sha256");
  hash.update(`${check}\n${parts.inventory}\n`);
  for (const host of [...parts.hosts].sort((a, b) => a.name.localeCompare(b.name))) hash.update(`${host.name}=${host.address}\n`);
  for (const file of parts.files ?? []) hash.update(`file:${file}\n`);
  for (const content of parts.contents ?? []) hash.update(`content:${createHash("sha256").update(content).digest("hex")}\n`);
  if (parts.vars !== undefined) hash.update(`vars:${parts.vars}\n`);
  return hash.digest("hex");
}

const ALWAYS_FILE = "lab-always.json";

/** "Yes, always for this project" applies only to junos-commit style checks, never to ansible --check. */
export async function rememberLabAlways(stateDir: string, check: string, key: string): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, ALWAYS_FILE);
  const current = await readAlways(file);
  current[check] = key;
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, file);
}

export async function labAlwaysAllowed(stateDir: string, check: string, key: string): Promise<boolean> {
  return (await readAlways(path.join(stateDir, ALWAYS_FILE)))[check] === key;
}

async function readAlways(file: string): Promise<Record<string, string>> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > 65_536) return {};
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch { return {}; }
}
