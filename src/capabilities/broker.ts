import { createHash } from "node:crypto";
import type { JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import { isRecord } from "../mcp/config";
import type { MCPManager, MCPTool } from "../mcp/manager";
import type { RuntimeTool } from "../runtime/types";
import { boundCapabilityResult, type BoundedCapabilityResult } from "./result";

export type CapabilitySafety = "read" | "diagnostic" | "write" | "destructive" | "exec" | "external-action";
export interface CapabilityDescriptor {
  id: string;
  source: string;
  name: string;
  description: string;
  tags: string[];
  safety: CapabilitySafety;
  schemaRef: string;
}
interface Capability {
  descriptor: CapabilityDescriptor;
  tool: MCPTool;
  runtimeName: string;
  fingerprint: string;
  router: boolean;
  schemaBytes: number;
  nameWords: Set<string>;
  descriptionWords: Set<string>;
  validate?: JsonSchemaValidator<unknown>;
}
export type ConfirmCapability = (call: {
  capability: CapabilityDescriptor; arguments: Record<string, unknown>;
}, signal?: AbortSignal) => Promise<boolean>;

let validatorModule: typeof import("@modelcontextprotocol/sdk/validation/ajv-provider.js") | undefined;
let validatorLoad: Promise<NonNullable<typeof validatorModule>> | undefined;
const MAX_SCHEMA_BYTES = 12_000;
const MAX_DIRECT_SCHEMA_BYTES = 32_000;
function requireSupportedSchema(capability: Capability): void {
  if (capability.schemaBytes > MAX_SCHEMA_BYTES) throw new Error("Capability schema exceeds 12 KB exposure budget");
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
const STOP_WORDS = new Set(["the", "a", "an", "to", "of", "for", "and", "in", "with", "please", "tool", "tools", "read", "get", "show", "use"]);
function words(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 1 && !STOP_WORDS.has(word)))];
}
function safety(tool: MCPTool): CapabilitySafety {
  // Names can only tighten policy, never grant read permission.
  if (tool.name === "invoke_tool" || tool.name === "invoke_tools_batch" || tool.annotations?.destructiveHint === true) return "destructive";
  if (/\b(delete|destroy|remove|reset|reboot|wipe)\b/.test(tool.name.replaceAll("_", " "))) return "destructive";
  if (/\b(exec|execute|shell|run)\b/.test(tool.name.replaceAll("_", " "))) return "exec";
  if (/\b(create|update|set|write|deploy)\b/.test(tool.name.replaceAll("_", " "))) return "write";
  const declared = tool._meta?.["casper/safety"];
  if (typeof declared === "string" && ["diagnostic", "write", "destructive", "exec", "external-action"].includes(declared)) return declared as CapabilitySafety;
  return tool.annotations?.readOnlyHint === true ? "read" : "external-action";
}

/** Index locally; send schemas only for selected tools or explicit inspection. */
export class CapabilityBroker {
  private capabilities = new Map<string, Capability>();
  private indexedRevision = -1;
  private readonly closed = new AbortController();
  constructor(private readonly manager: MCPManager, private readonly confirm?: ConfirmCapability) {}

  async prepare(task: string): Promise<RuntimeTool[]> {
    if (this.closed.signal.aborted) return [];
    await this.manager.prepare();
    this.sync();
    return this.toolsForTask(task);
  }

  search(query: string, limit = 5): CapabilityDescriptor[] {
    this.sync();
    return this.rank(query).slice(0, Math.min(10, Math.max(1, limit))).map((c) => structuredClone(c.descriptor));
  }

  describe(id: string): { capability: CapabilityDescriptor; inputSchema: MCPTool["inputSchema"] } {
    this.sync();
    const capability = this.get(id);
    requireSupportedSchema(capability);
    return structuredClone({ capability: capability.descriptor, inputSchema: capability.tool.inputSchema });
  }

  async invoke(id: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<BoundedCapabilityResult> {
    const combined = signal ? AbortSignal.any([signal, this.closed.signal]) : this.closed.signal;
    combined.throwIfAborted();
    this.sync();
    const capability = this.get(id);
    if (!isRecord(args) || Buffer.byteLength(JSON.stringify(args)) > 16_384) throw new Error("MCP arguments must be an object within 16 KB");
    const frozenArgs = structuredClone(args);
    requireSupportedSchema(capability);
    // Also validate fallback calls; a generic invocation schema is not permission
    // to bypass the target tool's actual schema.
    let valid = false;
    try {
      if (!capability.validate) {
        validatorModule ??= await (validatorLoad ??= import("@modelcontextprotocol/sdk/validation/ajv-provider.js"));
        capability.validate ??= new validatorModule.AjvJsonSchemaValidator().getValidator(capability.tool.inputSchema);
      }
      valid = capability.validate(frozenArgs).valid;
    } catch { throw new Error("Unsupported MCP input schema; call blocked"); }
    // A first-use import yields: do not ask for approval using a cancelled call
    // or stale catalog, even before the existing post-approval identity check.
    combined.throwIfAborted();
    this.sync();
    if (this.get(id).fingerprint !== capability.fingerprint) throw new Error("MCP tool changed during validation; search and review again");
    if (!valid) throw new Error("Invalid MCP arguments; inspect the capability schema");
    if (capability.descriptor.safety !== "read") {
      const approved = await this.confirm?.({
        capability: structuredClone(capability.descriptor), arguments: structuredClone(frozenArgs),
      }, combined);
      if (!approved) throw new Error(`MCP ${capability.descriptor.safety} call requires explicit interactive confirmation; not executed`);
    }
    combined.throwIfAborted();
    this.sync();
    if (this.get(id).fingerprint !== capability.fingerprint) throw new Error("MCP tool changed during approval; search and review again");
    return boundCapabilityResult(await this.manager.call(capability.descriptor.source, capability.tool.name, frozenArgs, combined));
  }

  close(): Promise<void> {
    this.closed.abort();
    this.capabilities.clear();
    return this.manager.close();
  }

  private sync(): void {
    const revision = this.manager.catalogRevision;
    if (revision === this.indexedRevision) return;
    const next = new Map<string, Capability>();
    if (!this.closed.signal.aborted) for (const { server, generation, tools } of this.manager.catalog()) {
      const routed = tools.some((tool) => tool.name === "find_tool") && tools.some((tool) => tool.name === "invoke_read_tool");
      for (const tool of tools) {
        const id = `mcp:${encodeURIComponent(server)}:${encodeURIComponent(tool.name)}`;
        const descriptor: CapabilityDescriptor = {
          id, source: server, name: tool.name, description: (tool.description ?? "").slice(0, 1024),
          tags: [], safety: safety(tool), schemaRef: id,
        };
        const tags = tool._meta?.tags;
        if (Array.isArray(tags)) descriptor.tags = tags.filter((tag): tag is string => typeof tag === "string").slice(0, 8).map((tag) => tag.slice(0, 64));
        next.set(id, {
          descriptor, tool, runtimeName: `mcp_${tool.name.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 24)}_${hash(id).slice(0, 24)}`,
          fingerprint: `${generation}:${hash(JSON.stringify(tool))}`,
          router: routed && ["find_tool", "invoke_read_tool", "invoke_tool"].includes(tool.name),
          // Budget the escaped representation too, so lossless schema inspection
          // fits the result envelope without truncating enum/required arrays.
          schemaBytes: Buffer.byteLength(JSON.stringify(JSON.stringify(tool.inputSchema))),
          nameWords: new Set(words(`${descriptor.name} ${descriptor.source} ${descriptor.tags.join(" ")}`)),
          descriptionWords: new Set(words(descriptor.description)),
        });
      }
    }
    this.capabilities = next;
    this.indexedRevision = revision;
  }

  private get(id: string): Capability {
    const capability = this.capabilities.get(id);
    if (!capability) throw new Error("Unknown or unavailable capability; use find_capability");
    return capability;
  }

  private rank(query: string): Capability[] {
    const terms = words(query);
    return [...this.capabilities.values()].map((capability) => {
      return { capability, score: terms.reduce((score, term) => score + (capability.nameWords.has(term) ? 4 : capability.descriptionWords.has(term) ? 1 : 0), 0) };
    }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score || a.capability.descriptor.id.localeCompare(b.capability.descriptor.id))
      .map(({ capability }) => capability);
  }

  private toolsForTask(task: string): RuntimeTool[] {
    if (!this.manager.status().length) return [];
    const wrap = (name: string, description: string, inputSchema: Record<string, unknown>, execute: RuntimeTool["execute"]): RuntimeTool => ({
      name, description, inputSchema,
      execute: async (args, signal) => {
        try { return await execute(args, signal); }
        catch (error) {
          // Local errors are controlled strings; raw transport errors are removed by the manager.
          return { text: JSON.stringify(boundCapabilityResult({ isError: true, message: error instanceof Error ? error.message : "Capability failed" })), isError: true };
        }
      },
    });
    const tools: RuntimeTool[] = [
      wrap("find_capability", "Search connected MCP capability metadata by query, or inspect one exact id to load its complete input schema as a JSON string in inputSchemaJson (parse it before calling). Omit the unused field or leave it empty. No server calls. Results bounded to 16 KB. If none are connected, ask the user to /mcp connect a server.", {
        type: "object", properties: { query: { type: "string" }, id: { type: "string" } }, additionalProperties: false,
      }, async (args) => {
        const id = typeof args.id === "string" ? args.id.trim() : "";
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (Boolean(id) === Boolean(query)) throw new Error("Supply either a nonempty query or id; leave the other empty");
        const result = id ? { id, inputSchemaJson: JSON.stringify(this.describe(id).inputSchema) } : this.search(query);
        return { text: JSON.stringify(boundCapabilityResult(result)) };
      }),
      wrap("call_capability", "Call a capability by exact id and arguments after inspecting its schema with find_capability. Same safety checks as direct tools. Results bounded to 16 KB / 50 array items; never automatically retry consequential calls.", {
        type: "object", properties: { id: { type: "string" }, arguments: { type: "object", additionalProperties: true } }, required: ["id", "arguments"], additionalProperties: false,
      }, async (args, signal) => {
        if (typeof args.id !== "string" || !isRecord(args.arguments)) throw new Error("Expected id and arguments object");
        const result = await this.invoke(args.id, args.arguments, signal);
        return { text: JSON.stringify(result), isError: result.isError };
      }),
    ];
    // Native routers are intentionally preferred over flattening their catalog.
    const routers = [...this.capabilities.values()].filter((c) => c.router).sort((a, b) => a.descriptor.id.localeCompare(b.descriptor.id));
    const routedServers = new Set(routers.map((c) => c.descriptor.source));
    const candidates = [...routers, ...this.rank(task).filter((c) => !routedServers.has(c.descriptor.source))];
    let schemaBytes = 0;
    for (const capability of candidates) {
      if (tools.length >= 8) break;
      const bytes = capability.schemaBytes;
      if (bytes > MAX_SCHEMA_BYTES || schemaBytes + bytes > MAX_DIRECT_SCHEMA_BYTES) continue;
      schemaBytes += bytes;
      tools.push(wrap(capability.runtimeName,
        `[${capability.descriptor.safety}; ${capability.descriptor.id}] ${capability.descriptor.description}\nBounded result; non-read calls require confirmation.`,
        structuredClone(capability.tool.inputSchema), async (args, signal) => {
          const result = await this.invoke(capability.descriptor.id, args, signal);
          return { text: JSON.stringify(result), isError: result.isError };
        }));
    }
    return tools;
  }
}
