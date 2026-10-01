import { realpathSync } from "node:fs";
import { openFollowed } from "../platform/files";
import os from "node:os";
import path from "node:path";
import { isValidProfileName } from "../config/profile";
import { duplicateDiagnostics, importAll, type ImportedFrom } from "./import";

/** Where a discovered definition came from; programmatic definitions carry none.
 * "imported" definitions come from other tools' files (WP4) and always start outside the project. */
export type ServerDefinitionScope = "user" | "profile" | "project" | "imported";

/** Per-server time limits. They are not part of a server's identity: changing one keeps consent. */
export interface MCPServerLimits {
  /** How long starting (handshake plus tool list) may take. */
  connectMs?: number;
  /** How long a call may go without any answer or progress from the server. */
  callMs?: number;
}

/** Thrown when a server definition names ${VAR} and VAR is not set. The message names it, never a value. */
export class MissingEnvironmentError extends Error {
  constructor(readonly variable: string) {
    super(`Missing environment variable ${variable}`);
    this.name = "MissingEnvironmentError";
  }
}

export interface MCPServerDefinition {
  name: string;
  source: string;
  /** Project files are repository content: connecting one needs an interactive review. */
  scope?: ServerDefinitionScope;
  /** The user/profile file whose same-named definition this project definition replaces. */
  shadows?: string;
  cwd: string;
  disabled: boolean;
  /** Optional "connectTimeout"/"callTimeout" from the file, in ms. */
  limits?: MCPServerLimits;
  /** Set when the definition was found in another tool's file (Claude Code, VS Code). */
  importedFrom?: ImportedFrom;
  transport: { type: "stdio"; command: string; args: string[]; env: Record<string, string> }
    | { type: "http"; url: string; headers: Record<string, string> };
}

export interface MCPConfiguration {
  servers: MCPServerDefinition[];
  diagnostics: string[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringMap(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.values(value).some((v) => typeof v !== "string")) throw new Error("invalid mapping");
  return value as Record<string, string>;
}

/** What a rejected entry may say about itself: Casper's fixed reasons, never text that could hold a value. */
const ENTRY_REASONS = new Set(["cwd must be absolute, ~/..., or ${PROJECT_ROOT}", "cwd outside the project", "HTTPS required outside loopback",
  "invalid args", "invalid cwd", "invalid definition", "invalid disabled flag", "invalid URL", "missing command", "too many servers",
  "unsupported transport", "invalid callTimeout", "invalid connectTimeout"]);

/**
 * Where a stdio server starts. Your own (user/profile) servers start in your home folder by default,
 * so an opened repository cannot change what they load; `cwd` may name an absolute folder, `~/...`,
 * or `${PROJECT_ROOT}` to opt back in. Project servers are repository content and start at the
 * project root, or at a `cwd` (relative, or absolute) that stays inside it.
 *
 * Imported servers (from other tools' files) never start in the opened project: with no `cwd` they
 * start in your home folder, and a `cwd` inside the project is replaced by the home folder and
 * reported. When the opened project IS your home folder, they start in ~/.casper instead.
 */
export function startFolder(value: unknown, scope: ServerDefinitionScope, projectRoot: string, home: string,
  report?: { name: string; diagnostics: string[] }): string {
  if (scope === "imported") {
    const outside = path.resolve(projectRoot) === path.resolve(home) ? path.join(home, ".casper") : home;
    if (value === undefined) return outside;
    const wanted = personalFolder(value, projectRoot, home);
    // Compared as real folders too, so a link that points into the project counts as the project.
    const inProject = [[projectRoot, wanted], [realFolder(projectRoot), realFolder(wanted)]].some(([root, folder]) => {
      const inside = path.relative(root!, folder!);
      return path.resolve(projectRoot) === path.resolve(home)
        ? inside === ""
        : inside === "" || !(inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside));
    });
    if (!inProject) return wanted;
    report?.diagnostics.push(`${report.name}: starts in your home folder, not in this project.`);
    return outside;
  }
  if (value === undefined) return scope === "project" ? projectRoot : home;
  if (scope === "project") {
    if (typeof value !== "string" || !value.trim()) throw new Error("invalid cwd");
    const resolved = path.resolve(projectRoot, value);
    const inside = path.relative(projectRoot, resolved);
    // Absolute is fine while it stays inside: opened on your home folder, ~/.mcp.json names folders under ~.
    if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) throw new Error("cwd outside the project");
    return resolved;
  }
  return personalFolder(value, projectRoot, home);
}

/** The folder with links resolved, or the plain path when it does not exist (yet). */
function realFolder(folder: string): string {
  try { return realpathSync.native(folder); } catch { return path.resolve(folder); }
}

function personalFolder(value: unknown, projectRoot: string, home: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("invalid cwd");
  if (value === "${PROJECT_ROOT}") return projectRoot;
  if (value === "~" || value.startsWith("~/")) return path.join(home, value.slice(1));
  if (!path.isAbsolute(value)) throw new Error("cwd must be absolute, ~/..., or ${PROJECT_ROOT}");
  return path.normalize(value);
}

/** Optional whole-second limit keys: "connectTimeout" (1-120) and "callTimeout" (1-1800). */
function limits(value: Record<string, unknown>): MCPServerLimits | undefined {
  const seconds = (key: string, max: number): number | undefined => {
    const raw = value[key];
    if (raw === undefined) return undefined;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > max) throw new Error(`invalid ${key}`);
    return raw * 1000;
  };
  const connectMs = seconds("connectTimeout", 120);
  const callMs = seconds("callTimeout", 1800);
  if (connectMs === undefined && callMs === undefined) return undefined;
  return { ...(connectMs !== undefined ? { connectMs } : {}), ...(callMs !== undefined ? { callMs } : {}) };
}

function definition(name: string, value: unknown, source: string, cwd: string): MCPServerDefinition {
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(name) || !isRecord(value)) throw new Error("invalid definition");
  if (value.disabled !== undefined && typeof value.disabled !== "boolean") throw new Error("invalid disabled flag");
  const limit = limits(value);
  const base = { name, source, cwd, disabled: value.disabled === true, ...(limit ? { limits: limit } : {}) };
  if (value.url !== undefined) {
    if (value.type !== undefined && value.type !== "http" && value.type !== "streamable-http") throw new Error("unsupported transport");
    if (typeof value.url !== "string" || value.command !== undefined) throw new Error("invalid URL");
    const url = new URL(value.url);
    if (url.username || url.password || url.hash) throw new Error("invalid URL");
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
      throw new Error("HTTPS required outside loopback");
    }
    return { ...base, transport: { type: "http", url: url.href, headers: stringMap(value.headers) } };
  }
  if (value.type !== undefined && value.type !== "stdio") throw new Error("unsupported transport");
  if (typeof value.command !== "string" || !value.command.trim()) throw new Error("missing command");
  const args = value.args ?? [];
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new Error("invalid args");
  return { ...base, transport: { type: "stdio", command: value.command, args, env: stringMap(value.env) } };
}

/** Short names for the files other tools keep their servers in, as /mcp shows them. */
export const IMPORT_LABELS: Record<ImportedFrom, string> = {
  claude: "~/.claude.json", "claude-project": "~/.claude.json (this project)", vscode: "VS Code",
  "mcp.json": "~/.mcp.json", "vscode-project": ".vscode/mcp.json",
};

type ReadResult = { kind: "missing" } | { kind: "error" } | { kind: "ok"; document: unknown };
/** One of Casper's own JSON files, at most 1 MiB. */
async function readConfigFile(source: string, maxBytes = 1024 * 1024): Promise<ReadResult> {
  try {
    const file = await openFollowed(source);
    try {
      if (!(await file.stat()).isFile()) throw new Error("configuration must be a regular file");
      const bytes = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead === bytes.length) throw new Error("oversized config");
      return { kind: "ok", document: JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")) };
    } finally { await file.close(); }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "error" };
  }
}

interface Layer {
  source: string;
  scope: ServerDefinitionScope;
  label: string;
  importedFrom?: ImportedFrom;
  entries: [string, unknown][];
}

/**
 * Metadata only. No subprocesses, HTTP, environment expansion, or trust grants.
 *
 * Layers, lowest first: servers found in other tools' files (VS Code user settings, ~/.mcp.json,
 * ~/.claude.json and its entry for this project), then ~/.casper/mcp.json, the profile file, and
 * the project's files (.vscode/mcp.json, mcp.json, .mcp.json, .casper/mcp.json). A later layer
 * replaces a same-named server. Imported servers use the "imported" scope, so they never start
 * in the opened project; the project's .vscode/mcp.json is project content and gets the review.
 */
export async function discoverMCPConfiguration(options: {
  projectRoot: string; homeDir?: string; profileName?: string;
  /** Read servers from Claude Code and VS Code files too (default true). */
  imports?: boolean; platform?: NodeJS.Platform;
}): Promise<MCPConfiguration> {
  const home = options.homeDir ?? os.homedir();
  const profile = options.profileName ?? "default";
  const diagnostics: string[] = [];
  const layers: Layer[] = [];
  let projectImports: Layer[] = [];
  if (options.imports !== false) {
    const found = await importAll({ home, projectRoot: options.projectRoot, platform: options.platform });
    diagnostics.push(...found.user.diagnostics, ...found.project.diagnostics);
    layers.push(...found.user.files.map((file) => ({
      source: file.source, scope: file.scope, label: IMPORT_LABELS[file.importedFrom], importedFrom: file.importedFrom, entries: [...file.servers],
    })));
    projectImports = found.project.files.map((file) => ({
      source: file.source, scope: file.scope, label: IMPORT_LABELS[file.importedFrom], importedFrom: file.importedFrom, entries: [...file.servers],
    }));
  }
  const files: { source: string; scope: ServerDefinitionScope; label: string }[] = [
    { source: path.join(home, ".casper/mcp.json"), scope: "user", label: "~/.casper/mcp.json" },
  ];
  if (isValidProfileName(profile)) {
    files.push({ source: path.join(home, ".casper/profiles", profile, "mcp.json"), scope: "profile", label: `~/.casper/profiles/${profile}/mcp.json` });
  }
  const own: Layer[] = [];
  const projectFiles: Layer[] = [];
  const read = async ({ source, scope, label }: typeof files[number], into: Layer[]) => {
    const result = await readConfigFile(source);
    if (result.kind === "missing") return;
    if (result.kind === "error") { diagnostics.push(`Cannot read MCP configuration: ${source}`); return; }
    const document = result.document;
    if (!isRecord(document) || !isRecord(document.mcpServers)) { diagnostics.push(`Expected an mcpServers map: ${source}`); return; }
    into.push({ source, scope, label, entries: Object.entries(document.mcpServers) });
  };
  for (const file of files) await read(file, own);
  for (const file of ["mcp.json", ".mcp.json", ".casper/mcp.json"]) {
    await read({ source: path.join(options.projectRoot, file), scope: "project", label: file }, projectFiles);
  }
  // Same name in several personal layers: say which one is used, when an import is involved.
  const personalLayers = [...layers, ...own];
  const imported = new Set(layers.flatMap((layer) => layer.entries.map(([name]) => name)));
  diagnostics.push(...duplicateDiagnostics(personalLayers.map((layer) => ({
    label: layer.label, names: layer.entries.map(([name]) => name).filter((name) => imported.has(name)),
  }))));
  const servers = new Map<string, MCPServerDefinition>();
  const personal = new Map<string, string>();
  for (const { source, scope, entries, importedFrom } of [...personalLayers, ...projectImports, ...projectFiles]) {
    for (const [name, value] of entries) {
      // Invalid overrides must not silently reactivate a lower-precedence definition.
      servers.delete(name);
      try {
        if (servers.size >= 64) throw new Error("too many servers");
        const shadows = scope === "project" ? personal.get(name) : undefined;
        const cwd = startFolder(isRecord(value) ? value.cwd : undefined, scope, options.projectRoot, home, { name, diagnostics });
        servers.set(name, {
          ...definition(name, value, source, cwd), scope, ...(shadows ? { shadows } : {}), ...(importedFrom ? { importedFrom } : {}),
        });
        if (scope !== "project") personal.set(name, source);
      } catch (error) {
        // Only Casper's own reasons are shown; a parser's message (new URL) could quote a value from the file.
        const reason = error instanceof Error && ENTRY_REASONS.has(error.message) ? ` (${error.message})` : "";
        diagnostics.push(`Invalid or unsupported MCP entry ${JSON.stringify(name.slice(0, 64))}${reason}: ${source}`);
      }
    }
  }
  return { servers: [...servers.values()].sort((a, b) => a.name.localeCompare(b.name)), diagnostics };
}

/** `${NAME}`, or Claude Code's `${NAME:-default}` (the default is used when NAME is unset or empty). */
const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** The `${NAME}` references in a value, in order, without duplicates. */
function references(value: string): string[] {
  return [...new Set([...value.matchAll(REFERENCE)].map((match) => match[1]!))];
}

/** One line per variable a definition would hand over: where it goes and through which header or env
 * entry. A project file can aim `${ANTHROPIC_API_KEY}` at any origin, so the review must say so. */
function sendsLines(transport: MCPServerDefinition["transport"]): string[] {
  if (transport.type === "http") {
    const origin = new URL(transport.url).origin;
    return Object.entries(transport.headers).flatMap(([header, value]) => references(value).map((name) => `sends $${name} to ${origin} (header ${header})`));
  }
  return Object.entries(transport.env).flatMap(([key, value]) => references(value).map((name) => `passes $${name} to the command (env ${key})`));
}

/** Review text for a project-scope definition: its file, what it replaces, and what it runs or
 * contacts. Literal environment and header values are never shown; `${VAR}` references are named,
 * unresolved, with where they would go. */
export function projectDefinitionReview(definition: MCPServerDefinition): string | undefined {
  if (definition.scope !== "project") return undefined;
  const transport = definition.transport;
  return [
    "MCP server confirmation",
    `name: ${JSON.stringify(definition.name)}`,
    `source: ${definition.source} (project file)`,
    ...(definition.shadows ? [`replaces your definition in: ${definition.shadows}`] : []),
    ...(transport.type === "stdio"
      ? [`command: ${JSON.stringify(transport.command)}`, `args: ${JSON.stringify(transport.args)}`,
        `env names (values hidden): ${JSON.stringify(Object.keys(transport.env))}`, `cwd: ${definition.cwd}`]
      : [`url origin: ${new URL(transport.url).origin}`, `header names (values hidden): ${JSON.stringify(Object.keys(transport.headers))}`]),
    ...sendsLines(transport),
    "",
  ].join("\n");
}

/** Only explicit ${ENV_NAME} (or ${ENV_NAME:-default}) references; never shell commands or config writes. */
export function resolveEnvironment(value: string): string {
  return value.replace(REFERENCE, (_whole, name: string, fallback: string | undefined) => {
    const resolved = process.env[name];
    if (fallback !== undefined) return resolved === undefined || resolved === "" ? fallback : resolved;
    if (resolved === undefined) throw new MissingEnvironmentError(name);
    return resolved;
  });
}

/**
 * The secret-like values a server is given, for hiding them in its output: every resolved env and
 * header value, each ${VAR} value they name, and ${VAR}-resolved argument values. Only values of 4+
 * characters (shorter ones would hide ordinary text). Missing variables are skipped.
 */
export function resolvedSecrets(definition: MCPServerDefinition): string[] {
  const values = new Set<string>();
  const add = (value: string | undefined) => { if (value !== undefined && value.length >= 4) values.add(value); };
  const take = (value: string, whole: boolean) => {
    const named = references(value);
    for (const name of named) add(process.env[name]);
    if (!whole && !named.length) return;
    try { add(resolveEnvironment(value)); } catch { /* a missing variable has no value to hide */ }
  };
  const transport = definition.transport;
  if (transport.type === "stdio") {
    for (const value of Object.values(transport.env)) take(value, true);
    for (const value of transport.args) take(value, false);
  } else {
    for (const value of Object.values(transport.headers)) take(value, true);
  }
  return [...values];
}
