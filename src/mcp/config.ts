import { constants } from "node:fs";
import { open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isValidProfileName } from "../config/profile";

export interface MCPServerDefinition {
  name: string;
  source: string;
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
  const files = [path.join(home, ".casper/mcp.json")];
  if (isValidProfileName(profile)) {
    files.push(path.join(home, ".casper/profiles", profile, "mcp.json"));
  }
  files.push(...["mcp.json", ".mcp.json", ".casper/mcp.json"].map((file) => path.join(options.projectRoot, file)));
  const servers = new Map<string, MCPServerDefinition>();
  const diagnostics: string[] = [];
  for (const source of files) {
    let document: unknown;
    try {
      const file = await open(source, constants.O_RDONLY | constants.O_NONBLOCK);
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
        servers.set(name, definition(name, value, source, options.projectRoot));
      } catch {
        diagnostics.push(`Invalid or unsupported MCP entry ${JSON.stringify(name.slice(0, 64))}: ${source}`);
      }
    }
  }
  return { servers: [...servers.values()].sort((a, b) => a.name.localeCompare(b.name)), diagnostics };
}

/** Only explicit ${ENV_NAME} references; never shell commands or config writes. */
export function resolveEnvironment(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const resolved = process.env[name];
    if (resolved === undefined) throw new Error("Required MCP environment variable is missing");
    return resolved;
  });
}
