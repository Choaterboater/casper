import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { openFollowed } from "../platform/files";
import { isRecord, type MCPServerDefinition } from "./config";
import type { MCPTool } from "./manager";
import type { PresetMatch } from "./presets";

/**
 * Docs servers: hpe-networking-mcp's rag-core ("aruba-rag" is its old name). Casper keeps its docs
 * tools in front of the model, but only for a stdio server Casper recognised as hpe-networking-mcp
 * by what it runs. Any other server with the same tool names gets no special place.
 */
export const DOCS_TOOL_NAMES = ["lookup_api", "search_docs", "ask_docs"] as const;

/** The text in front of a docs tool's own description. */
export const DOCS_TOOL_NOTE = "Check docs here before guessing Aruba, HPE, Mist or Junos API and config details. Say when the docs had no answer.";

/** A tool list with search_docs plus lookup_api or ask_docs. */
export function isDocsServer(tools: readonly Pick<MCPTool, "name">[]): boolean {
  const names = new Set(tools.map((tool) => tool.name));
  return names.has("search_docs") && (names.has("lookup_api") || names.has("ask_docs"));
}

/**
 * True when this server's docs tools are kept in front of the model: hpe-networking-mcp recognised by
 * its definition (not by its tool names), started by Casper over stdio, with a docs tool list.
 */
export function docsPinned(definition: MCPServerDefinition | undefined, match: PresetMatch | undefined, tools: readonly Pick<MCPTool, "name">[]): boolean {
  return !!definition && definition.transport.type === "stdio" && match?.preset.id === "hpe-networking-mcp"
    && match.by === "definition" && isDocsServer(tools);
}

function lastArg(definition: MCPServerDefinition): string | undefined {
  return definition.transport.type === "stdio" ? definition.transport.args.at(-1)?.replaceAll("\\", "/") : undefined;
}

/** A definition that runs rag.py on its own (a docs-only copy). */
export function isDocsOnlyDefinition(definition: MCPServerDefinition): boolean {
  return /(^|\/)mcp_servers\/rag\.py$/.test(lastArg(definition) ?? "");
}

/** Env entries the docs-only copy keeps. Everything else (CREDS_PATH, vendor keys, HPE_MCP_*) is left out. */
const DOCS_ENV = ["PYTHONPATH", "HPE_MCP_RAG_BACKEND"];

export interface DocsOnlyEntry { command: string; args: string[]; cwd?: string; env: Record<string, string> }

/**
 * The docs-only copy of an hpe-networking-mcp router definition (args ending in
 * mcp_servers/tool_router.py): the same command and folder, running mcp_servers/rag.py, with no
 * credentials. Undefined for anything else.
 */
export function docsOnlyDefinition(definition: MCPServerDefinition): DocsOnlyEntry | undefined {
  if (definition.transport.type !== "stdio") return undefined;
  const { command, args, env } = definition.transport;
  const last = args.at(-1);
  if (!last || !/(^|[\\/])mcp_servers[\\/]tool_router\.py$/.test(last)) return undefined;
  const kept = Object.fromEntries(DOCS_ENV.filter((key) => typeof env[key] === "string").map((key) => [key, env[key]!]));
  return {
    command, args: [...args.slice(0, -1), last.replace(/tool_router\.py$/, "rag.py")], cwd: definition.cwd, env: kept,
  };
}

export const MCP_FILE_LABEL = "~/.casper/mcp.json";
const MAX_MCP_FILE_BYTES = 1024 * 1024;

export class ServerExistsError extends Error {
  constructor(readonly name: string) {
    super(`${name} is already in ${MCP_FILE_LABEL}. Nothing changed.`);
    this.name = "ServerExistsError";
  }
}

/**
 * Add one server to ~/.casper/mcp.json. Create-only: it keeps every entry already there, refuses a
 * name that is already used, and writes a temporary file that then replaces the old one. The file
 * is created (0600) when missing.
 */
export async function addUserServer(home: string, name: string, entry: DocsOnlyEntry): Promise<string> {
  const file = path.join(home, ".casper", "mcp.json");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name)) throw new Error(`Cannot add ${name}: not a valid server name.`);
  let document: Record<string, unknown> = { mcpServers: {} };
  let mode = 0o600;
  try {
    const handle = await openFollowed(file);
    try {
      if (!(await handle.stat()).isFile()) throw new Error("not a file");
      const bytes = Buffer.alloc(MAX_MCP_FILE_BYTES + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > MAX_MCP_FILE_BYTES) throw new Error("too large");
      const parsed: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
      if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) throw new Error("no map");
      document = { ...parsed, mcpServers: parsed.mcpServers ?? {} };
    } finally { await handle.close(); }
    mode = (await stat(file)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Cannot read ${MCP_FILE_LABEL}. Nothing changed.`);
  }
  const servers = document.mcpServers as Record<string, unknown>;
  if (Object.hasOwn(servers, name)) throw new ServerExistsError(name);
  servers[name] = { command: entry.command, args: [...entry.args], ...(entry.cwd ? { cwd: entry.cwd } : {}), env: { ...entry.env } };
  const next = `${JSON.stringify(document, null, 2)}\n`;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, next, { flag: "wx", mode });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return file;
}
