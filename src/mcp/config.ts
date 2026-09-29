import { openFollowed } from "../platform/files";
import os from "node:os";
import path from "node:path";
import { isValidProfileName } from "../config/profile";

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

/**
 * Where a stdio server starts. Your own (user/profile) servers start in your home folder by default,
 * so an opened repository cannot change what they load; `cwd` may name an absolute folder, `~/...`,
 * or `${PROJECT_ROOT}` to opt back in. Project servers are repository content and start at the
 * project root, or at a relative `cwd` that stays inside it.
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
    const inside = path.relative(path.resolve(projectRoot), wanted);
    const inProject = path.resolve(projectRoot) === path.resolve(home)
      ? inside === ""
      : inside === "" || !(inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside));
    if (!inProject) return wanted;
    report?.diagnostics.push(`${report.name}: starts in your home folder, not in this project.`);
    return outside;
  }
  if (value === undefined) return scope === "project" ? projectRoot : home;
  if (scope === "project") {
    if (typeof value !== "string" || !value.trim()) throw new Error("invalid cwd");
    const resolved = path.resolve(projectRoot, value);
    const inside = path.relative(projectRoot, resolved);
    if (path.isAbsolute(value) || inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) throw new Error("cwd outside the project");
    return resolved;
  }
  return personalFolder(value, projectRoot, home);
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

/** Metadata only. No subprocesses, HTTP, environment expansion, or trust grants. */
export async function discoverMCPConfiguration(options: {
  projectRoot: string; homeDir?: string; profileName?: string;
}): Promise<MCPConfiguration> {
  const home = options.homeDir ?? os.homedir();
  const profile = options.profileName ?? "default";
  const files: { source: string; scope: ServerDefinitionScope }[] = [{ source: path.join(home, ".casper/mcp.json"), scope: "user" }];
  if (isValidProfileName(profile)) {
    files.push({ source: path.join(home, ".casper/profiles", profile, "mcp.json"), scope: "profile" });
  }
  files.push(...["mcp.json", ".mcp.json", ".casper/mcp.json"].map((file) => ({ source: path.join(options.projectRoot, file), scope: "project" as const })));
  const servers = new Map<string, MCPServerDefinition>();
  const personal = new Map<string, string>();
  const diagnostics: string[] = [];
  for (const { source, scope } of files) {
    let document: unknown;
    try {
      const file = await openFollowed(source);
      try {
        if (!(await file.stat()).isFile()) throw new Error("configuration must be a regular file");
        const bytes = Buffer.alloc(1024 * 1024 + 1);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead === bytes.length) throw new Error("oversized config");
        document = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
      } finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") diagnostics.push(`Cannot read MCP configuration: ${source}`);
      continue;
    }
    if (!isRecord(document) || !isRecord(document.mcpServers)) {
      diagnostics.push(`Expected an mcpServers map: ${source}`);
      continue;
    }
    for (const [name, value] of Object.entries(document.mcpServers)) {
      // Invalid overrides must not silently reactivate a lower-precedence definition.
      servers.delete(name);
      try {
        if (servers.size >= 64) throw new Error("too many servers");
        const shadows = scope === "project" ? personal.get(name) : undefined;
        const cwd = startFolder(isRecord(value) ? value.cwd : undefined, scope, options.projectRoot, home, { name, diagnostics });
        servers.set(name, { ...definition(name, value, source, cwd), scope, ...(shadows ? { shadows } : {}) });
        if (scope !== "project") personal.set(name, source);
      } catch {
        diagnostics.push(`Invalid or unsupported MCP entry ${JSON.stringify(name.slice(0, 64))}: ${source}`);
      }
    }
  }
  return { servers: [...servers.values()].sort((a, b) => a.name.localeCompare(b.name)), diagnostics };
}

const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

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

/** Only explicit ${ENV_NAME} references; never shell commands or config writes. */
export function resolveEnvironment(value: string): string {
  return value.replace(REFERENCE, (_, name: string) => {
    const resolved = process.env[name];
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
