import { openFollowed } from "../platform/files";
import os from "node:os";
import path from "node:path";
import { isValidProfileName } from "../config/profile";

/** Where a discovered definition came from; programmatic definitions carry none. */
export type ServerDefinitionScope = "user" | "profile" | "project";

export interface MCPServerDefinition {
  name: string;
  source: string;
  /** Project files are repository content: connecting one needs an interactive review. */
  scope?: ServerDefinitionScope;
  /** The user/profile file whose same-named definition this project definition replaces. */
  shadows?: string;
  cwd: string;
  disabled: boolean;
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
 */
function startFolder(value: unknown, scope: ServerDefinitionScope, projectRoot: string, home: string): string {
  if (value === undefined) return scope === "project" ? projectRoot : home;
  if (typeof value !== "string" || !value.trim()) throw new Error("invalid cwd");
  if (scope === "project") {
    const resolved = path.resolve(projectRoot, value);
    const inside = path.relative(projectRoot, resolved);
    if (path.isAbsolute(value) || inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) throw new Error("cwd outside the project");
    return resolved;
  }
  if (value === "${PROJECT_ROOT}") return projectRoot;
  if (value === "~" || value.startsWith("~/")) return path.join(home, value.slice(1));
  if (!path.isAbsolute(value)) throw new Error("cwd must be absolute, ~/..., or ${PROJECT_ROOT}");
  return path.normalize(value);
}

function definition(name: string, value: unknown, source: string, cwd: string): MCPServerDefinition {
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(name) || !isRecord(value)) throw new Error("invalid definition");
  if (value.disabled !== undefined && typeof value.disabled !== "boolean") throw new Error("invalid disabled flag");
  const base = { name, source, cwd, disabled: value.disabled === true };
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
        const cwd = startFolder(isRecord(value) ? value.cwd : undefined, scope, options.projectRoot, home);
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
    if (resolved === undefined) throw new Error("Required MCP environment variable is missing");
    return resolved;
  });
}
