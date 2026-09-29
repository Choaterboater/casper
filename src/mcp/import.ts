import os from "node:os";
import path from "node:path";
import { openFollowed } from "../platform/files";

/**
 * Finds MCP servers you already set up in Claude Code (~/.claude.json, including the entry for this
 * project), ~/.mcp.json and VS Code, so you don't have to copy them. Metadata only: nothing is
 * started, no environment is read, and nothing else in those files is kept or printed. Each entry is
 * turned into Casper's own mcpServers shape (type, command, args, env, cwd, url, headers, disabled)
 * for config.ts to validate and layer like any other file.
 *
 * Diagnostics name the file and the entry, never a value from it.
 */

export type ImportedFrom = "claude" | "claude-project" | "vscode" | "mcp.json" | "vscode-project";

export interface ImportedFile {
  /** Absolute path of the file. */
  source: string;
  /** Short name for messages: "~/.claude.json", "VS Code", ... */
  label: string;
  importedFrom: ImportedFrom;
  /** "imported" servers start outside the project; ".vscode/mcp.json" is project content. */
  scope: "imported" | "project";
  /** Entries in Casper's mcpServers shape, in file order. */
  servers: Map<string, Record<string, unknown>>;
}

export interface ImportResult {
  /** Lowest precedence first. */
  files: ImportedFile[];
  diagnostics: string[];
}

const CLAUDE_MAX_BYTES = 32 * 1024 * 1024;
const OTHER_MAX_BYTES = 4 * 1024 * 1024;
const MAX_SERVERS_PER_FILE = 64;
const NAME = /^[a-zA-Z0-9_.-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const quote = (name: string) => JSON.stringify(name.slice(0, 64));

type ReadOutcome = { kind: "missing" } | { kind: "error"; reason: "size" | "read" } | { kind: "ok"; text: string };
async function readText(file: string, maxBytes: number): Promise<ReadOutcome> {
  let handle;
  try { handle = await openFollowed(file); } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR"
      ? { kind: "missing" } : { kind: "error", reason: "read" };
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return { kind: "error", reason: "read" };
    if (stats.size > maxBytes) return { kind: "error", reason: "size" };
    const bytes = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > maxBytes) return { kind: "error", reason: "size" };
    return { kind: "ok", text: bytes.subarray(0, total).toString("utf8") };
  } catch { return { kind: "error", reason: "read" }; } finally { await handle.close(); }
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

interface Translate { home: string; workspaceFolder?: string; label: string; name: string }
class Skip extends Error {}

/**
 * VS Code variables into Casper's: ${env:X} -> ${X}, ${userHome} -> home, ${workspaceFolder} ->
 * the project (project files only). Anything Casper can't fill in skips the entry.
 */
function translateString(value: string, context: Translate): string {
  return value.replace(/\$\{([^}]*)\}/g, (whole, inner: string) => {
    const env = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(inner);
    if (env) return `\${${env[1]}}`;
    if (inner === "userHome") return context.home;
    if (inner === "workspaceFolder") {
      if (context.workspaceFolder !== undefined) return context.workspaceFolder;
      throw new Skip(`Skipped ${quote(context.name)} from ${context.label}: uses \${workspaceFolder} in a user file; Casper can't tell which folder.`);
    }
    if (inner.startsWith("input:")) {
      throw new Skip(`Skipped ${quote(context.name)} from ${context.label}: it asks VS Code for a value (\${${inner.slice(0, 40)}}). Put it in ~/.casper/mcp.json instead.`);
    }
    // Plain ${NAME} and Claude's ${NAME:-default} pass through for config.ts to resolve.
    if (/^[A-Za-z_][A-Za-z0-9_]*(:-[^}]*)?$/.test(inner)) return whole;
    throw new Skip(`Skipped ${quote(context.name)} from ${context.label}: uses \${${inner.slice(0, 40)}}, which Casper can't fill in.`);
  });
}

function stringList(value: unknown, context: Translate): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Skip(`Skipped ${quote(context.name)} from ${context.label}: its args are not a list of strings.`);
  return (value as string[]).map((item) => translateString(item, context));
}
function stringMap(value: unknown, context: Translate, what: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== "string")) {
    throw new Skip(`Skipped ${quote(context.name)} from ${context.label}: its ${what} is not a list of names and text values.`);
  }
  const out: Record<string, string> = Object.create(null);
  for (const [key, item] of Object.entries(value)) out[key] = translateString(item as string, context);
  return out;
}

/** One entry in Casper's shape. Unknown keys are dropped; values are never put in messages. */
function translateEntry(value: unknown, context: Translate): Record<string, unknown> {
  if (!isRecord(value)) throw new Skip(`Skipped ${quote(context.name)} from ${context.label}: the entry is not an object.`);
  if (value.type === "sse" || value.transport === "sse") {
    throw new Skip(`Skipped ${quote(context.name)} from ${context.label}: SSE transport is not supported.`);
  }
  if (value.envFile !== undefined) throw new Skip(`Skipped ${quote(context.name)} from ${context.label}: envFile is not supported.`);
  const out: Record<string, unknown> = {};
  if (value.type !== undefined) out.type = value.type === "streamableHttp" ? "http" : value.type;
  if (typeof value.command === "string") out.command = translateString(value.command, context);
  else if (value.command !== undefined) out.command = value.command;
  const args = stringList(value.args, context);
  if (args) out.args = args;
  const env = stringMap(value.env, context, "env");
  if (env) out.env = env;
  if (typeof value.url === "string") out.url = translateString(value.url, context);
  else if (value.url !== undefined) out.url = value.url;
  const headers = stringMap(value.headers, context, "headers");
  if (headers) out.headers = headers;
  if (typeof value.cwd === "string") out.cwd = translateString(value.cwd, context);
  else if (value.cwd !== undefined) out.cwd = value.cwd;
  if (value.disabled !== undefined) out.disabled = value.disabled;
  return out;
}

/** A stdio entry with no cwd whose args look like paths relative to the project. */
function needsProjectFolder(entry: Record<string, unknown>): boolean {
  if (entry.cwd !== undefined || typeof entry.command !== "string") return false;
  const words = [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])].filter((word): word is string => typeof word === "string");
  return words.some((word) => !word.startsWith("-") && !path.isAbsolute(word) && !word.startsWith("~")
    && !word.startsWith("${") && (word.startsWith(".") || word.includes("/") || /\.(py|js|mjs|ts)$/.test(word)));
}

function collect(
  entries: unknown, file: Omit<ImportedFile, "servers">, context: Omit<Translate, "name" | "label">, diagnostics: string[],
): ImportedFile | undefined {
  if (entries === undefined) return undefined;
  if (!isRecord(entries)) {
    diagnostics.push(`Skipped ${file.label}: its server list is not an object.`);
    return undefined;
  }
  const servers = new Map<string, Record<string, unknown>>();
  for (const [name, value] of Object.entries(entries)) {
    if (!NAME.test(name)) {
      diagnostics.push(`Skipped ${quote(name)} from ${file.label}: a name can only use letters, numbers, dot, dash and underscore.`);
      continue;
    }
    if (servers.size >= MAX_SERVERS_PER_FILE) {
      diagnostics.push(`Skipped the rest of ${file.label}: more than ${MAX_SERVERS_PER_FILE} servers.`);
      break;
    }
    try {
      const entry = translateEntry(value, { ...context, label: file.label, name });
      servers.set(name, entry);
      if (file.importedFrom === "claude-project" && needsProjectFolder(entry)) {
        diagnostics.push(`${quote(name)} from ${file.label} starts in your home folder, not the project. If it needs the project folder, copy it to ~/.casper/mcp.json with "cwd": "\${PROJECT_ROOT}".`);
      }
    } catch (error) {
      if (error instanceof Skip) diagnostics.push(error.message);
      else diagnostics.push(`Skipped ${quote(name)} from ${file.label}: Casper can't read this entry.`);
    }
  }
  return { ...file, servers };
}

function parseJson(text: string): unknown { return JSON.parse(text); }
function parseJsonc(text: string): unknown { return Bun.JSONC.parse(text); }

async function readDocument(
  file: string, label: string, maxBytes: number, parse: (text: string) => unknown, diagnostics: string[],
): Promise<unknown> {
  const read = await readText(file, maxBytes);
  if (read.kind === "missing") return undefined;
  if (read.kind === "error") {
    diagnostics.push(read.reason === "size"
      ? `Skipped ${label}: it is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`
      : `Cannot read ${label}. Try /mcp reload.`);
    return undefined;
  }
  try { return parse(read.text); } catch {
    // A half-written file is never used in part.
    diagnostics.push(label === "~/.claude.json"
      ? "Cannot read ~/.claude.json (it may be in use). Try /mcp reload."
      : `Cannot read ${label} (it is not valid JSON). Try /mcp reload.`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/**
 * ~/.claude.json: top-level mcpServers and projects[projectRoot].mcpServers only. The file also
 * holds history and account data, so it gets its own 32 MB cap and nothing else is kept.
 */
export async function importClaudeConfig(home: string, projectRoot: string): Promise<ImportResult> {
  const source = path.join(home, ".claude.json");
  const diagnostics: string[] = [];
  const document = await readDocument(source, "~/.claude.json", CLAUDE_MAX_BYTES, parseJson, diagnostics);
  const files: ImportedFile[] = [];
  if (!isRecord(document)) {
    if (document !== undefined) diagnostics.push("Cannot read ~/.claude.json (it may be in use). Try /mcp reload.");
    return { files, diagnostics };
  }
  const context = { home };
  const top = collect(document.mcpServers, { source, label: "~/.claude.json", importedFrom: "claude", scope: "imported" }, context, diagnostics);
  if (top) files.push(top);
  const projects = document.projects;
  if (isRecord(projects)) {
    const root = path.resolve(projectRoot);
    const key = Object.keys(projects).find((candidate) => path.isAbsolute(candidate) && path.resolve(candidate) === root);
    const project = key === undefined ? undefined : projects[key];
    if (isRecord(project)) {
      const entry = collect(project.mcpServers, {
        source, label: "~/.claude.json (this project)", importedFrom: "claude-project", scope: "imported",
      }, context, diagnostics);
      if (entry) files.push(entry);
    }
  }
  return { files, diagnostics };
}

/** ~/.mcp.json. Skipped when the project is the home folder, where it is already read as a project file. */
export async function importHomeMcpJson(home: string, projectRoot: string): Promise<ImportResult> {
  const diagnostics: string[] = [];
  if (path.resolve(projectRoot) === path.resolve(home)) return { files: [], diagnostics };
  const source = path.join(home, ".mcp.json");
  const document = await readDocument(source, "~/.mcp.json", OTHER_MAX_BYTES, parseJson, diagnostics);
  if (document === undefined) return { files: [], diagnostics };
  if (!isRecord(document)) { diagnostics.push("Skipped ~/.mcp.json: expected an mcpServers map."); return { files: [], diagnostics }; }
  const file = collect(document.mcpServers, { source, label: "~/.mcp.json", importedFrom: "mcp.json", scope: "imported" }, { home }, diagnostics);
  return { files: file ? [file] : [], diagnostics };
}

/** VS Code's user folders (stable and Insiders) for this platform. */
export function vscodeUserDirs(home: string, platform: NodeJS.Platform = process.platform, appData = process.env.APPDATA): string[] {
  const editions = ["Code", "Code - Insiders"];
  if (platform === "darwin") return editions.map((edition) => path.join(home, "Library", "Application Support", edition, "User"));
  if (platform === "win32") {
    const base = appData ?? path.join(home, "AppData", "Roaming");
    return editions.map((edition) => path.join(base, edition, "User"));
  }
  return editions.map((edition) => path.join(home, ".config", edition, "User"));
}

/** VS Code user settings: mcp.json ("servers") and settings.json ("mcp"."servers"). JSONC allowed. */
export async function importVSCodeConfig(home: string, platform: NodeJS.Platform = process.platform, appData?: string): Promise<ImportResult> {
  const diagnostics: string[] = [];
  const files: ImportedFile[] = [];
  for (const dir of vscodeUserDirs(home, platform, appData ?? process.env.APPDATA)) {
    const edition = dir.includes("Insiders") ? "VS Code Insiders" : "VS Code";
    const settings = path.join(dir, "settings.json");
    const settingsDocument = await readDocument(settings, `${edition} settings.json`, OTHER_MAX_BYTES, parseJsonc, diagnostics);
    if (isRecord(settingsDocument) && isRecord(settingsDocument.mcp)) {
      const file = collect(settingsDocument.mcp.servers, { source: settings, label: edition, importedFrom: "vscode", scope: "imported" }, { home }, diagnostics);
      if (file) files.push(file);
    }
    const mcp = path.join(dir, "mcp.json");
    const mcpDocument = await readDocument(mcp, `${edition} mcp.json`, OTHER_MAX_BYTES, parseJsonc, diagnostics);
    if (mcpDocument !== undefined) {
      if (!isRecord(mcpDocument)) diagnostics.push(`Skipped ${edition} mcp.json: expected a "servers" map.`);
      else {
        const file = collect(mcpDocument.servers, { source: mcp, label: edition, importedFrom: "vscode", scope: "imported" }, { home }, diagnostics);
        if (file) files.push(file);
      }
    }
  }
  return { files, diagnostics };
}

/** <project>/.vscode/mcp.json: project content, reviewed like the project's own MCP files. */
export async function importVSCodeProject(projectRoot: string, home: string): Promise<ImportResult> {
  const diagnostics: string[] = [];
  const source = path.join(projectRoot, ".vscode", "mcp.json");
  const document = await readDocument(source, ".vscode/mcp.json", OTHER_MAX_BYTES, parseJsonc, diagnostics);
  if (document === undefined) return { files: [], diagnostics };
  if (!isRecord(document)) { diagnostics.push('Skipped .vscode/mcp.json: expected a "servers" map.'); return { files: [], diagnostics }; }
  const file = collect(document.servers, {
    source, label: ".vscode/mcp.json", importedFrom: "vscode-project", scope: "project",
  }, { home, workspaceFolder: projectRoot }, diagnostics);
  return { files: file ? [file] : [], diagnostics };
}

/**
 * Every import source, lowest precedence first: VS Code user, ~/.mcp.json, ~/.claude.json,
 * ~/.claude.json for this project. Casper's own files and the project files layer above these (in
 * config.ts). The project's .vscode/mcp.json is returned separately as a project file.
 */
export async function importAll(options: {
  home?: string; projectRoot: string; platform?: NodeJS.Platform; appData?: string;
}): Promise<{ user: ImportResult; project: ImportResult }> {
  const home = options.home ?? os.homedir();
  const parts = [
    await importVSCodeConfig(home, options.platform, options.appData),
    await importHomeMcpJson(home, options.projectRoot),
    await importClaudeConfig(home, options.projectRoot),
  ];
  const user: ImportResult = { files: parts.flatMap((part) => part.files), diagnostics: parts.flatMap((part) => part.diagnostics) };
  const project = await importVSCodeProject(options.projectRoot, home);
  return { user, project };
}

/**
 * One line per server name found in more than one layer: which layers have it and which one wins
 * (the last one). Pass layers lowest precedence first, e.g. the imports and then ~/.casper/mcp.json.
 */
export function duplicateDiagnostics(layers: readonly { label: string; names: Iterable<string> }[]): string[] {
  const seen = new Map<string, string[]>();
  for (const layer of layers) {
    for (const name of layer.names) {
      const labels = seen.get(name) ?? [];
      if (!labels.includes(layer.label)) labels.push(layer.label);
      seen.set(name, labels);
    }
  }
  const lines: string[] = [];
  for (const [name, labels] of seen) {
    if (labels.length < 2) continue;
    const winner = labels.at(-1)!;
    const others = labels.slice(0, -1);
    const listed = others.length === 1 ? others[0] : `${others.slice(0, -1).join(", ")} and ${others.at(-1)}`;
    lines.push(`${quote(name)} is in ${listed}; using ${winner}`);
  }
  return lines;
}
