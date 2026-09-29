import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { discoverMCPConfiguration, isRecord, type MCPServerDefinition } from "../config";
import { matchPreset } from "../presets";
import type { McpCheckCommand } from "../../cli-args";
import type { Finding } from "./index";
import { SECRET_ENV_NAME } from "./sandbox";

const MAX_FILE = 1024 * 1024;
const MAX_EXAMPLE_FILES = 50;

/** One server entry in an example config file. */
export type ExampleEntry = Record<string, unknown>;

export interface ExampleConfig {
  /** Relative to the repo root, forward slashes. */
  file: string;
  entries: Record<string, ExampleEntry>;
}

/** How the check starts the server. Placeholders such as `${workspaceFolder}` are already replaced. */
export type StartDefinition = {
  name: string;
  /** Where it came from: "--server", "--", ".casper/mcp-check.json" or an example file. */
  source: string;
  cwd: string;
} & ({ type: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { type: "http"; url: string; headers: Record<string, string> });

/** The optional `.casper/mcp-check.json` in the repo. */
export interface CheckConfig {
  /** The start command as argv, or a server entry like in .mcp.json. */
  start?: string[] | ExampleEntry;
  doctor?: string;
  safetyTests?: string;
  tests?: string;
}

async function readJson(file: string): Promise<unknown> {
  const info = await lstat(file);
  if (!info.isFile()) throw new Error("not a file");
  if (info.size > MAX_FILE) throw new Error("over 1 MiB");
  return JSON.parse(await readFile(file, "utf8"));
}

/** Reads `.casper/mcp-check.json`. Missing is fine; a broken file is a usage-style problem the report names. */
export async function readCheckConfig(root: string): Promise<{ config: CheckConfig; error?: string }> {
  let document: unknown;
  try { document = await readJson(path.join(root, ".casper/mcp-check.json")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: {} };
    return { config: {}, error: `.casper/mcp-check.json can't be read: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isRecord(document)) return { config: {}, error: ".casper/mcp-check.json must be a JSON object" };
  const config: CheckConfig = {};
  for (const key of ["doctor", "safetyTests", "tests"] as const) {
    const value = document[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.trim()) return { config: {}, error: `.casper/mcp-check.json: "${key}" must be a command string` };
    config[key] = value;
  }
  const start = document.start;
  if (start !== undefined) {
    const argv = Array.isArray(start) && start.length > 0 && start.every((part) => typeof part === "string") && (start[0] as string).trim();
    if (!argv && !isRecord(start)) return { config: {}, error: '.casper/mcp-check.json: "start" must be a command list like ["uv", "run", "server"] or a server entry' };
    config.start = start as CheckConfig["start"];
  }
  return { config };
}

function serverMap(document: unknown): Record<string, ExampleEntry> | undefined {
  if (!isRecord(document)) return undefined;
  const map = isRecord(document.mcpServers) ? document.mcpServers : isRecord(document.servers) ? document.servers : undefined;
  if (!map) return undefined;
  return Object.fromEntries(Object.entries(map).filter(([, value]) => isRecord(value))) as Record<string, ExampleEntry>;
}

async function listFiles(root: string, relative: string, depth: number, match: (name: string) => boolean, out: string[], limit: number): Promise<void> {
  if (depth < 0 || out.length >= limit) return;
  let entries;
  try { entries = await readdir(path.join(root, relative), { withFileTypes: true }); } catch { return; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= limit) return;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory() && depth > 0 && entry.name !== "node_modules" && !entry.name.startsWith(".")) await listFiles(root, child, depth - 1, match, out, limit);
    else if (entry.isFile() && match(entry.name)) out.push(child);
  }
}

/** Example MCP configs the repo ships: .mcp.json*, mcp.json*, .vscode/mcp.json*, .cursor/mcp*.json and
 * examples/**\/*.json (4 levels, 50 files) that hold `mcpServers` or `servers`. Files only; nothing runs. */
export async function findExampleConfigs(root: string): Promise<ExampleConfig[]> {
  const candidates: string[] = [];
  await listFiles(root, "", 0, (name) => /^\.?mcp\.json/.test(name), candidates, 100);
  await listFiles(root, ".vscode", 0, (name) => /^mcp\.json/.test(name), candidates, 100);
  await listFiles(root, ".cursor", 0, (name) => /^mcp.*\.json/.test(name), candidates, 100);
  const examples: string[] = [];
  await listFiles(root, "examples", 3, (name) => name.endsWith(".json"), examples, MAX_EXAMPLE_FILES);
  const found: ExampleConfig[] = [];
  for (const file of [...candidates, ...examples]) {
    try {
      const entries = serverMap(await readJson(path.join(root, file)));
      if (entries) found.push({ file, entries });
    } catch { /* unreadable or not JSON: not an example config */ }
  }
  return found;
}

const PLACEHOLDER = /^\$\{[^}]*\}$|^<[^>]*>$|^(|x+|\*+|\.\.\.|changeme|change[-_ ]?me|todo|none|null|placeholder)$|your[-_ ]|replace[-_ ]?(me|this)|example|dummy|redacted/i;

/** A value someone could paste as a real secret: not empty, not ${NAME}, not an obvious placeholder. */
function literalSecret(value: string): boolean {
  const trimmed = value.trim().replace(/^(Bearer|Basic|Token)\s+/i, "");
  return !PLACEHOLDER.test(trimmed) && !/\$\{[^}]+\}/.test(trimmed);
}

function isOn(value: string): boolean { return /^(1|true|yes|on)$/i.test(value.trim()); }
function isOff(value: string): boolean { return /^(0|false|no|off)$/i.test(value.trim()); }

/** A setting that turns writes on, as `NAME=value`, or undefined. */
function writeSwitchOn(name: string, value: string): boolean {
  return (/WRITES?$/i.test(name) && isOn(value))
    || (/READ_?ONLY$/i.test(name) && isOff(value))
    || (/ACCESS_PROFILE$/i.test(name) && /full-read-write|read-write|full/i.test(value))
    || (/PRODUCT_ACCESS$/i.test(name) && /read-?write|write/i.test(value));
}

function writeSwitchOff(name: string, value: string): boolean {
  return (/WRITES?$/i.test(name) && isOff(value))
    || (/READ_?ONLY$/i.test(name) && isOn(value))
    || (/ACCESS_PROFILE$/i.test(name) && /read-?only/i.test(value))
    || (/PRODUCT_ACCESS$/i.test(name) && /read-?only/i.test(value));
}

/** A file whose name says it turns writes on: a note there, a problem in a default example. */
export function namedForWrites(file: string): boolean {
  return /(full|write|rw|admin|unsafe)/i.test(path.posix.basename(file).replace(/read-?only/gi, ""));
}

function stringEntries(value: unknown): Array<[string, string]> {
  return isRecord(value) ? Object.entries(value).filter((pair): pair is [string, string] => typeof pair[1] === "string") : [];
}

/** Whether this example sets any read-only or write switch at all. */
export function hasAccessSwitch(entries: Record<string, ExampleEntry>): boolean {
  return Object.values(entries).some((entry) => stringEntries(entry.env).some(([name, value]) => writeSwitchOn(name, value) || writeSwitchOff(name, value)));
}

/** For a server Casper has a preset for (WP4): the setting that keeps it read-only, when this entry
 * does not set it. Casper sets it itself while writes are off, but other tools that use the example
 * don't. Undefined when the entry keeps writes off, or when there is no such setting. */
export function missingPresetSwitch(name: string, entry: ExampleEntry, file: string): string | undefined {
  if (typeof entry.command !== "string") return undefined;
  const definition: MCPServerDefinition = {
    name, source: file, cwd: "", disabled: false,
    transport: { type: "stdio", command: entry.command, args: Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === "string") : [], env: Object.fromEntries(stringEntries(entry.env)) },
  };
  const preset = matchPreset(definition)?.preset;
  const pins = preset?.pins;
  if (!preset || !pins) return undefined;
  if (preset.userKeepsWritesOff) {
    if (preset.userKeepsWritesOff(definition).length) return undefined;
  } else {
    const transport = definition.transport as Extract<MCPServerDefinition["transport"], { type: "stdio" }>;
    const envSet = Object.entries(pins.env).every(([key, value]) => transport.env[key] === value);
    if (envSet && pins.appendArgs.every((arg) => transport.args.includes(arg))) return undefined;
  }
  const first = Object.entries(pins.env)[0];
  return first ? `${first[0]}=${first[1]}` : pins.appendArgs.join(" ");
}

/** Problems in one example config: literal secrets (length only, never the value) and settings that turn
 * writes on. A write switch is a problem in a default example and a note in a file named for writes. */
export function reviewExampleConfig(file: string, entries: Record<string, ExampleEntry>): Finding[] {
  const findings: Finding[] = [];
  const writes: string[] = [];
  const missing: string[] = [];
  for (const [entryName, entry] of Object.entries(entries)) {
    const setting = missingPresetSwitch(entryName, entry, file);
    if (setting && !missing.includes(setting)) missing.push(setting);
    for (const [name, value] of stringEntries(entry.env)) {
      if (SECRET_ENV_NAME.test(name) && literalSecret(value)) {
        findings.push({ section: "examples", status: "fail", label: file, text: `has a secret in plain text (env ${name}, ${value.length} chars). Use \${${name}}.` });
      }
      if (writeSwitchOn(name, value)) writes.push(`${name}=${value}`);
    }
    for (const [name, value] of stringEntries(entry.headers)) {
      if ((SECRET_ENV_NAME.test(name) || /^(authorization|x-api-key|cookie)$/i.test(name)) && literalSecret(value)) {
        findings.push({ section: "examples", status: "fail", label: file, text: `has a secret in plain text (header ${name}, ${value.length} chars). Use \${NAME} and set NAME in your shell.` });
      }
    }
  }
  if (writes.length) {
    const shown = `${writes[0]}${writes.length > 1 ? ` and ${writes.length - 1} more` : ""}`;
    findings.push(namedForWrites(file)
      ? { section: "examples", status: "note", label: file, text: "turns writes on (the name says so)" }
      : { section: "examples", status: "fail", label: file, text: `turns writes on (${shown}). The default example should be read-only.` });
  } else if (missing.length) {
    findings.push(namedForWrites(file)
      ? { section: "examples", status: "note", label: file, text: `does not keep writes off (no ${missing[0]}; the name says so)` }
      : { section: "examples", status: "warn", label: file, text: `does not set ${missing.join(" or ")}, the setting that keeps writes off. Casper sets it itself; other clients using this example don't.` });
  } else if (!findings.length) {
    findings.push({ section: "examples", status: "ok", label: file, text: hasAccessSwitch(entries) ? "keeps writes off" : "turns no writes on" });
  }
  return findings;
}

/** Findings for every example config, plus a warning when there are none or none has a read-only switch. */
export function reviewExampleConfigs(configs: ExampleConfig[]): Finding[] {
  if (!configs.length) return [{ section: "examples", status: "warn", label: "examples", text: "No example config file. Add .mcp.json.example so tools can set it up." }];
  const findings = configs.flatMap((config) => reviewExampleConfig(config.file, config.entries));
  if (!configs.some((config) => hasAccessSwitch(config.entries))) {
    findings.push({ section: "examples", status: "warn", label: "read-only", text: "No read-only switch found. Every tool that can change a device is always on." });
  }
  return findings;
}

/** Replaces `${workspaceFolder}` and `/path/to/<name>` with the real repo path. `<name>` is the repo
 * folder's name, or the project's own name from pyproject.toml or package.json (a copy of the repo
 * may sit in a folder with another name). */
export function fillPlaceholders(value: string, root: string, projectNames: readonly string[] = []): string {
  const names = [path.basename(root), ...projectNames].filter(Boolean).map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return value.replace(/\$\{workspaceFolder\}/g, root).replace(new RegExp(`/path/to/(?:${names.join("|")})(?![\\w.-])`, "g"), root);
}

/** The project's own name, from pyproject.toml `[project] name` or package.json `name`. */
export async function projectNames(root: string): Promise<string[]> {
  const names: string[] = [];
  try {
    const pyproject = await readFile(path.join(root, "pyproject.toml"), "utf8");
    const project = /^\[project\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(pyproject)?.[1] ?? "";
    const name = /^\s*name\s*=\s*["']([A-Za-z0-9_.-]+)["']/m.exec(project)?.[1];
    if (name) names.push(name);
  } catch { /* no pyproject */ }
  try {
    const name = (JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { name?: unknown }).name;
    if (typeof name === "string" && /^[A-Za-z0-9_.-]+$/.test(name)) names.push(name);
  } catch { /* no package.json */ }
  return names;
}

function fromEntry(name: string, entry: ExampleEntry, source: string, root: string, names: readonly string[] = []): StartDefinition | undefined {
  const fill = (value: string) => fillPlaceholders(value, root, names);
  const cwdValue = typeof entry.cwd === "string" ? fill(entry.cwd) : undefined;
  const cwd = cwdValue ? path.resolve(root, cwdValue) : root;
  if (typeof entry.url === "string") {
    return { name, source, cwd, type: "http", url: fill(entry.url), headers: Object.fromEntries(stringEntries(entry.headers)) };
  }
  if (typeof entry.command !== "string" || !entry.command.trim()) return undefined;
  const args = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === "string").map(fill) : [];
  const env = Object.fromEntries(stringEntries(entry.env).map(([key, value]) => [key, fill(value)]));
  return { name, source, cwd, type: "stdio", command: fill(entry.command), args, env };
}

const START_FILES = [".mcp.json.example", ".vscode/mcp.json.example", ".mcp.json"];

/** Which server to start, in order: --server, `--`, .casper/mcp-check.json, then the first stdio entry of
 * .mcp.json.example, .vscode/mcp.json.example, .mcp.json or examples/** (minimal or read-only names first).
 * It never reads README text or guesses from pyproject scripts: a script may default to an HTTP transport
 * and wait forever. */
export async function startDefinition(root: string, cmd: McpCheckCommand, config: CheckConfig, configs?: ExampleConfig[], homeDir?: string): Promise<StartDefinition | { error: string }> {
  if (cmd.server) {
    const found = await discoverMCPConfiguration({ projectRoot: root, ...(homeDir ? { homeDir } : {}) });
    const server = found.servers.find((entry) => entry.name === cmd.server);
    if (!server) return { error: `No server named ${cmd.server} in your MCP settings.` };
    return server.transport.type === "stdio"
      ? { name: server.name, source: "--server", cwd: server.cwd, ...server.transport }
      : { name: server.name, source: "--server", cwd: server.cwd, ...server.transport };
  }
  const name = path.basename(root);
  if (cmd.command?.length) {
    return { name, source: "--", cwd: root, type: "stdio", command: cmd.command[0]!, args: cmd.command.slice(1), env: {} };
  }
  if (config.start) {
    const definition = Array.isArray(config.start)
      ? fromEntry(name, { command: config.start[0], args: config.start.slice(1) }, ".casper/mcp-check.json", root, await projectNames(root))
      : fromEntry(name, config.start, ".casper/mcp-check.json", root, await projectNames(root));
    if (definition) return definition;
  }
  const all = configs ?? await findExampleConfigs(root);
  const byFile = new Map(all.map((entry) => [entry.file, entry]));
  const preferred = (file: string) => /minimal|read-?only/i.test(file) ? 0 : 1;
  const examples = all.filter((entry) => entry.file.startsWith("examples/"))
    .sort((a, b) => preferred(a.file) - preferred(b.file) || a.file.localeCompare(b.file));
  const ordered = [...START_FILES.map((file) => byFile.get(file)).filter((entry): entry is ExampleConfig => Boolean(entry)), ...examples];
  let http: StartDefinition | undefined;
  const names = await projectNames(root);
  for (const example of ordered) {
    for (const [entryName, entry] of Object.entries(example.entries)) {
      const definition = fromEntry(entryName, entry, example.file, root, names);
      if (definition?.type === "stdio") return definition;
      http ??= definition;
    }
  }
  if (http) return http;
  return { error: "Can't tell how to start this server. Add .mcp.json.example, or pass the command: casper mcp check . -- <command>" };
}

/** The start command as one line, for the report. */
export function startLine(definition: StartDefinition): string {
  return definition.type === "http" ? definition.url : [definition.command, ...definition.args].join(" ");
}
