import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import path from "node:path";
import { parse } from "yaml";
import { readPlaybook } from "./ansible";
import { MAX_SCAN_BYTES, readSmallText, resolveInside } from "./files";
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

export const LAB_CONFIG_PLACE = "~/.casper/config.yaml lab.hosts";
export const NO_LAB_REASON = "tell Casper your lab first: add lab.hosts to ~/.casper/config.yaml";
export const LAB_LIMIT_NOTE = "Casper checked the inventory and the playbook text; it cannot block other network traffic yet.";
export const labModelRefusal = (name: string): string => `Lab checks run only when you start them: /verify ${name}`;

export interface LabHost {
  /** The inventory name. */
  name: string;
  /** Where Ansible connects: ansible_host (or ansible_ssh_host) when set, otherwise the name. */
  address: string;
}

export type LabGuard = { ok: true } | { ok: false; host?: LabHost; reason: string };

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

/**
 * Every host must be on the lab list. A host with ansible_host is checked by
 * that address (where Ansible connects); a host without it by its name, which
 * must be listed exactly. Any miss refuses the whole check.
 */
export function guardLab(hosts: readonly (string | LabHost)[], settings: LabSettings | undefined): LabGuard {
  if (!settings || !settings.hosts.length) return { ok: false, reason: NO_LAB_REASON };
  if (!hosts.length) return { ok: false, reason: "the inventory lists no hosts" };
  const lab = matcher(settings);
  for (const raw of hosts) {
    const host = toHost(raw);
    if (!onList(host.address, lab)) return { ok: false, host, reason: "not in your lab list" };
  }
  return { ok: true };
}

const describeHost = (host: LabHost): string => host.address !== host.name ? `${host.name} (${host.address})` : host.name;

export function labRefusalText(check: string, guard: Exclude<LabGuard, { ok: true }>): string {
  if (guard.host) return `Refused: ${check} would reach ${describeHost(guard.host)}, which is not in your lab list (${LAB_CONFIG_PLACE}). Nothing was sent.`;
  if (guard.reason === NO_LAB_REASON) return `${check} not run: ${NO_LAB_REASON}`;
  return `Refused: ${check}: ${guard.reason}. Nothing was sent.`;
}

export interface ReachFinding { file: string; line: number; what: string }

export function reachRefusalText(finding: ReachFinding): string {
  return `Refused: ${finding.file} uses ${finding.what} (line ${finding.line}), so it can reach hosts outside the lab inventory. Nothing was sent.`;
}

/** Host variables that can send Ansible somewhere other than the listed address. */
const PROXY_VARIABLES = ["ansible_ssh_common_args", "ansible_ssh_extra_args", "ansible_ssh_args", "ansible_paramiko_proxy_command", "ansible_netconf_ssh_config", "ansible_psrp_proxy", "ansible_httpapi_proxy"];

export interface InventoryHosts { hosts: LabHost[]; problem?: string }

/** Read `ansible-inventory --list` JSON: every host and where it connects. */
export function inventoryHostsFromJson(text: string): InventoryHosts {
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
  for (const name of [...names].sort()) {
    const vars = hostvars[name] ?? {};
    for (const key of PROXY_VARIABLES) {
      const setting = vars[key];
      if (setting !== undefined && setting !== null && String(setting).trim() !== "") {
        return { hosts, problem: `host ${name} sets ${key}, which can route the connection through another machine` };
      }
    }
    const address = vars.ansible_host ?? vars.ansible_ssh_host;
    if (address !== undefined && typeof address !== "string") return { hosts, problem: `host ${name} has an ansible_host that is not plain text` };
    if (typeof address === "string" && /\{\{|\{%/.test(address)) return { hosts, problem: `host ${name} builds ansible_host from a template` };
    hosts.push({ name, address: typeof address === "string" && address.trim() ? address.trim() : name });
  }
  return { hosts };
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
  return inventoryHostsFromJson(result.stdout);
}

/** Lines that can point a playbook at hosts beyond its inventory, or run things Casper cannot check. */
const REACH_PATTERNS: { what: string; re: RegExp }[] = [
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

function scanText(file: string, text: string): ReachFinding | undefined {
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^\s*#/.test(line)) continue;
    const body = line.replace(/\s+#.*$/, "");
    for (const pattern of REACH_PATTERNS) if (pattern.re.test(body)) return { file, line: index + 1, what: pattern.what };
  }
  return undefined;
}

const INCLUDE = /^\s*-?\s*(?:ansible\.builtin\.)?(include_tasks|import_tasks|include_vars|include|include_role|import_role)\s*:\s*(.*)$/;

/**
 * Scan a playbook and every file it pulls in for ways to reach hosts beyond the
 * inventory: the playbook, vars_files, included task files, roles in the
 * project's roles/ folder, and group_vars/host_vars next to the playbook. A file
 * Casper cannot read ahead (a templated name, a role from a collection) is itself a refusal.
 * Stricter than Ansible needs, and still only a text scan.
 */
export async function scanPlaybookReach(root: string, playbook: string): Promise<ReachFinding | undefined> {
  const seen = new Set<string>();
  const queue: string[] = [playbook];
  const playbookDir = path.posix.dirname(playbook);
  for (const folder of ["group_vars", "host_vars"]) queue.push(...await listYaml(root, path.posix.join(playbookDir, folder)));
  let budget = 200;
  while (queue.length) {
    const relative = queue.shift()!;
    if (seen.has(relative)) continue;
    seen.add(relative);
    if (--budget < 0) return { file: playbook, line: 1, what: "more than 200 files" };
    let absolute: string;
    let text: string;
    try {
      absolute = await resolveInside(root, relative);
      text = await readSmallText(absolute, MAX_SCAN_BYTES);
    } catch {
      return { file: relative, line: 1, what: "a file Casper cannot read" };
    }
    const found = scanText(relative, text);
    if (found) return found;
    const base = path.posix.dirname(relative);
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index++) {
      const include = INCLUDE.exec(lines[index]!);
      if (include) {
        const kind = include[1]!;
        let target = include[2]!.trim().replace(/^['"]|['"]$/g, "");
        if (kind.endsWith("_role")) {
          const name = /name\s*:\s*['"]?([\w.-]+)/.exec(target)?.[1] ?? lines[index + 1]?.match(/^\s*name\s*:\s*['"]?([\w.-]+)/)?.[1];
          if (!name) return { file: relative, line: index + 1, what: `${kind} with a name Casper cannot read ahead` };
          const role = await roleFiles(root, base, name);
          if (!role) return { file: relative, line: index + 1, what: `role ${name}, which is not in the project's roles/ folder` };
          queue.push(...role);
          continue;
        }
        if (!target || target.includes("{{") || target.startsWith("/") || target.split("/").includes("..")) {
          return { file: relative, line: index + 1, what: `${kind} with a file Casper cannot read ahead` };
        }
        queue.push(path.posix.normalize(path.posix.join(base, target)));
      }
    }
    const parsed = relative === playbook ? readPlaybook(relative, text) : undefined;
    if (relative === playbook) {
      if (!parsed) return { file: relative, line: 1, what: "a file that is not a playbook" };
      let value: unknown;
      try { value = parse(text, { logLevel: "silent", maxAliasCount: 50, uniqueKeys: false, strict: false }); } catch { value = undefined; }
      for (const play of Array.isArray(value) ? value : []) {
        if (typeof play !== "object" || play === null) continue;
        const record = play as Record<string, unknown>;
        const files = typeof record.vars_files === "string" ? [record.vars_files] : Array.isArray(record.vars_files) ? record.vars_files : [];
        for (const file of files) {
          if (typeof file !== "string" || file.includes("{{") || file.startsWith("/") || file.split("/").includes("..")) {
            return { file: relative, line: lineNumber(text, /vars_files/), what: "vars_files Casper cannot read ahead" };
          }
          queue.push(path.posix.normalize(path.posix.join(base, file)));
        }
        const roles = Array.isArray(record.roles) ? record.roles : [];
        for (const role of roles) {
          const name = typeof role === "string" ? role : typeof role === "object" && role !== null ? (role as Record<string, unknown>).role ?? (role as Record<string, unknown>).name : undefined;
          if (typeof name !== "string" || name.includes("{{")) return { file: relative, line: lineNumber(text, /roles\s*:/), what: "a role Casper cannot read ahead" };
          const files = await roleFiles(root, base, name);
          if (!files) return { file: relative, line: lineNumber(text, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))), what: `role ${name}, which is not in the project's roles/ folder` };
          queue.push(...files);
        }
      }
    }
  }
  return undefined;
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

async function roleFiles(root: string, base: string, name: string): Promise<string[] | undefined> {
  if (!/^[\w-]+$/.test(name)) return undefined;
  for (const folder of [path.posix.join(base, "roles", name), path.posix.join("roles", name)]) {
    try {
      const absolute = await resolveInside(root, folder);
      if ((await lstat(absolute)).isDirectory()) return listYaml(root, folder);
    } catch { /* try the next place */ }
  }
  return undefined;
}

/** A fingerprint of what the user agreed to: the check, the inventory file, the hosts and the change file. */
export function labApprovalKey(check: string, parts: { inventory: string; hosts: readonly LabHost[]; files?: readonly string[] }): string {
  const hash = createHash("sha256");
  hash.update(`${check}\n${parts.inventory}\n`);
  for (const host of [...parts.hosts].sort((a, b) => a.name.localeCompare(b.name))) hash.update(`${host.name}=${host.address}\n`);
  for (const file of parts.files ?? []) hash.update(`file:${file}\n`);
  return hash.digest("hex");
}

const ALWAYS_FILE = "lab-always.json";

/** "Always for this project" applies only to junos-commit style checks, never to ansible --check. */
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
